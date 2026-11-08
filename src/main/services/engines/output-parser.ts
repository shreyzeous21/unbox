/**
 * Pure parsers for engine console output. Everything here is a pure function
 * over strings so it can be unit-tested against captured real output.
 *
 * Sources of truth: `7zz l -slt`, `7zz t`, `7zz x -bsp1`, `bsdtar -tvf`
 * captured from the vendored engines on macOS (see tests/unit/parser tests).
 */
import type { EngineListEntry, ListResult } from './engine-types'
import { LIST_HARD_CAP } from './engine-types'

// ---------------------------------------------------------------------------
// 7-Zip `-slt` structured listing
// ---------------------------------------------------------------------------

interface SltBlock {
  [key: string]: string
}

export interface SltBlockWithMarker {
  fields: SltBlock
  afterSeparator: boolean
}

/** Splits `7zz l -slt` output into blocks, marking which come after the `----------` entry separator. */
export function parseSltBlocks(output: string): SltBlockWithMarker[] {
  const blocks: SltBlockWithMarker[] = []
  let current: SltBlock = {}
  let afterSeparator = false
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (line === '----------') {
      // Everything before the separator is archive header; everything after is entries.
      if (Object.keys(current).length > 0) {
        blocks.push({ fields: current, afterSeparator })
        current = {}
      }
      afterSeparator = true
      continue
    }
    if (line === '') {
      if (Object.keys(current).length > 0) {
        blocks.push({ fields: current, afterSeparator })
        current = {}
      }
      continue
    }
    const eq = line.indexOf(' = ')
    if (eq > 0) {
      current[line.slice(0, eq)] = line.slice(eq + 3)
      continue
    }
    // "Key =" with empty value
    if (line.endsWith(' =')) {
      current[line.slice(0, -2)] = ''
    }
  }
  if (Object.keys(current).length > 0) blocks.push({ fields: current, afterSeparator })
  return blocks
}

export interface SevenZipListOutcome {
  list: ListResult
  archiveType?: string
  errorLines: string[]
}

/** Parses full `7zz l -slt` output (banner + optional header block + entry blocks). */
export function parseSevenZipSltListing(output: string): SevenZipListOutcome {
  const blocks = parseSltBlocks(output)
  const errorLines: string[] = []
  for (const raw of output.split(/\r?\n/)) {
    if (/^ERROR:/i.test(raw.trim()) || /^Cannot open/i.test(raw.trim())) errorLines.push(raw.trim())
  }

  const entries: EngineListEntry[] = []
  let archiveType: string | undefined
  let encrypted = false
  let truncated = false
  let totalUncompressed = 0
  let totalPacked = 0
  let sawSize = false
  let fileCount = 0
  let folderCount = 0

  for (const b of blocks) {
    const fields = b.fields
    // Entry blocks are those after the `----------` separator; header blocks
    // (Type/Physical Size/Method) come before it. zip listings carry a
    // "Folder" key, 7z listings do not — the separator is the reliable marker.
    if (!b.afterSeparator) {
      if (fields['Type']) archiveType = fields['Type']
      continue
    }
    const name = fields['Path'] ?? ''
    if (!name) continue
    if (entries.length >= LIST_HARD_CAP) {
      truncated = true
      break
    }
    // zip listings carry an explicit `Folder = +/-`; 7z listings do not —
    // directories are marked by a leading `D` in the Attributes string.
    const isDir = fields['Folder'] === '+' || /^D/.test(fields['Attributes'] ?? '')
    const isSymlink = /(^| )l/.test(fields['Attributes'] ?? '') || 'Symbolic Link' in fields
    const sizeRaw = fields['Size']
    const size = sizeRaw !== undefined && sizeRaw !== '' ? Number(sizeRaw) : undefined
    const packed = fields['Packed Size'] !== undefined && fields['Packed Size'] !== '' ? Number(fields['Packed Size']) : undefined
    const entryEncrypted = fields['Encrypted'] === '+'
    if (entryEncrypted) encrypted = true
    if (!isDir) fileCount++
    else folderCount++
    if (size !== undefined && Number.isFinite(size)) {
      sawSize = true
      totalUncompressed += size
    }
    if (packed !== undefined && Number.isFinite(packed)) totalPacked += packed

    entries.push({
      name,
      isDir,
      size,
      packedSize: packed,
      crc: fields['CRC'] || undefined,
      isSymlink,
      linkTarget: fields['Symbolic Link'] || undefined,
      encrypted: entryEncrypted || undefined
    })
  }

  return {
    archiveType,
    errorLines,
    list: {
      entries,
      totalUncompressed: sawSize ? totalUncompressed : undefined,
      totalPacked: totalPacked > 0 ? totalPacked : undefined,
      fileCount,
      folderCount,
      encrypted,
      archiveType,
      truncated
    }
  }
}

// ---------------------------------------------------------------------------
// 7-Zip test output (`7zz t`)
// ---------------------------------------------------------------------------

export interface SevenZipTestOutcome {
  ok: boolean
  cancelled: boolean
  errorLines: string[]
  everythingOk: boolean
}

export function parseSevenZipTestOutput(output: string, exitCode: number | null): SevenZipTestOutcome {
  const lines = output.split(/\r?\n/).map((l) => l.trim())
  const errorLines = lines.filter(
    (l) =>
      /^ERROR:/i.test(l) ||
      /^WARNING:/i.test(l) ||
      /^Cannot open/i.test(l) ||
      /Wrong password/i.test(l) ||
      /^Data Error/i.test(l) ||
      /^CRC Failed/i.test(l)
  )
  const everythingOk = /^Everything is Ok$/i.test(lines[lines.length - 2] ?? '') || /Everything is Ok/i.test(output)
  const cancelled = /interrupted by user/i.test(output) || /canceled/i.test(output)
  // 7-Zip exits 0 only when the test fully passed (2 = fatal, 1 = warnings).
  const ok = exitCode === 0 && everythingOk && !errorLines.some((l) => /^ERROR:/i.test(l))
  return { ok, cancelled, errorLines, everythingOk }
}

// ---------------------------------------------------------------------------
// 7-Zip extraction progress tokens (`-bsp1` mode)
// ---------------------------------------------------------------------------

export interface ProgressToken {
  percent?: number
  filesDone?: number
  currentFile?: string
  /** '+' = file opened, '-' = file completed (7-Zip console grammar). */
  fileDone?: string
}

/**
 * Incremental tokenizer for 7-Zip's `-bsp1` progress stream.
 * The stream contains backspace-overwritten percent updates and per-file
 * markers like ` 45% L2 12 + filename` / `- filename`. We feed every stdout
 * chunk through one tokenizer instance.
 */
export class SevenZipProgressTokenizer {
  private buffer = ''

  feed(chunk: string): ProgressToken[] {
    this.buffer += chunk
    const tokens: ProgressToken[] = []
    // \b (backspace) sequences erase the previous token on a real terminal;
    // when piped they separate updates. Treat \r, \n and \b as separators.
    const parts = this.buffer.split(/[\r\n\b]+/)
    // Keep the last partial segment in the buffer.
    this.buffer = parts.pop() ?? ''
    for (const part of parts) {
      const t = parseProgressLine(part)
      if (t) tokens.push(t)
    }
    return tokens
  }

  flush(): ProgressToken[] {
    const rest = this.buffer
    this.buffer = ''
    const t = rest ? parseProgressLine(rest) : undefined
    return t ? [t] : []
  }
}

export function parseProgressLine(line: string): ProgressToken | undefined {
  // Match: "NN% L1 M" (progress) optionally followed by "+ name" or "- name"
  const m = /^\s*(\d{1,3})%\s+(?:L\d+\s+)?(\d+)\s*([+-])?\s*(.*)$/.exec(line)
  if (m) {
    const percent = Number(m[1])
    const filesDone = Number(m[2])
    const marker = m[3]
    const rest = (m[4] ?? '').trim()
    return {
      percent: percent >= 0 && percent <= 100 ? percent : undefined,
      filesDone,
      ...(marker === '-' && rest ? { fileDone: rest } : {}),
      ...(marker === '+' && rest ? { currentFile: rest } : {}),
      ...(!marker && rest ? { currentFile: rest } : {})
    }
  }
  // "- name" alone = completed file line in some output modes.
  const done = /^-\s+(.+)$/.exec(line)
  if (done) return { fileDone: done[1]?.trim() }
  return undefined
}

// ---------------------------------------------------------------------------
// bsdtar `-tvf` listing
// ---------------------------------------------------------------------------

/**
 * `bsdtar -tvf` line grammar (macOS libarchive):
 *   -rw-r--r--  0 shrey   staff    1234 Nov  9 02:44 path/to/file
 *   lrwxr-xr-x  0 shrey   staff       7 Nov  9 02:44 link -> target
 *   drwxr-xr-x  0 shrey   staff       0 Nov  9 02:44 dir/
 * Fields are whitespace-separated but the path may contain spaces — so we
 * parse left-to-right structurally and treat everything after the mtime
 * seconds as the path. Locale: we force LC_ALL=C in the spawn.
 */
export interface BsdtarListOutcome {
  list: ListResult
  errorLines: string[]
}

export function parseBsdtarTvf(output: string): BsdtarListOutcome {
  const entries: EngineListEntry[] = []
  const errorLines: string[] = []
  let truncated = false
  let total = 0
  let sawSize = false
  let fileCount = 0
  let folderCount = 0
  let encrypted = false

  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim()) continue
    if (/^(bsdtar|tar): /i.test(line)) {
      errorLines.push(line)
      continue
    }
    if (entries.length >= LIST_HARD_CAP) {
      truncated = true
      break
    }
    // Structure: mode sp blocks sp owner sp group sp size sp mon sp day sp time sp path
    //            0        1       2      3       4      5    6    7     8...
    const parts = line.split(/\s+/)
    if (parts.length < 9) continue
    const mode = parts[0] ?? ''
    const sizeTok = parts[4] ?? ''
    const size = /^\d+$/.test(sizeTok) ? Number(sizeTok) : undefined
    const pathPart = parts.slice(8).join(' ')
    if (!pathPart) continue

    const isSymlink = mode.startsWith('l')
    let name = pathPart
    let linkTarget: string | undefined
    if (isSymlink) {
      const arrow = name.lastIndexOf(' -> ')
      if (arrow >= 0) {
        linkTarget = name.slice(arrow + 4)
        name = name.slice(0, arrow)
      }
    }
    const isDir = name.endsWith('/') || mode.startsWith('d')
    const cleanName = isDir && name.endsWith('/') ? name.slice(0, -1) : name
    if (isDir) {
      folderCount++
    } else if (isSymlink) {
      // Links carry the target length as "size" in -tv output; exclude from
      // both file count and byte totals.
    } else {
      fileCount++
      if (size !== undefined) {
        sawSize = true
        total += size
      }
    }

    entries.push({
      name: cleanName,
      isDir,
      size: isDir ? undefined : size,
      isSymlink: isSymlink || undefined,
      linkTarget
    })
  }

  return {
    errorLines,
    list: {
      entries,
      totalUncompressed: sawSize ? total : undefined,
      fileCount,
      folderCount,
      encrypted,
      truncated
    }
  }
}

// ---------------------------------------------------------------------------
// 7-Zip summary line (`Files: N`, `Size: N`) for post-extract accounting
// ---------------------------------------------------------------------------

export interface SevenZipSummary {
  files: number
  folders: number
  size?: number
  compressed?: number
  hasErrors: boolean
  errorLines: string[]
}

export function parseSevenZipExtractOutput(output: string, exitCode: number | null): SevenZipSummary {
  const lines = output.split(/\r?\n/).map((l) => l.trim())
  let files = 0
  let folders = 0
  let size: number | undefined
  let compressed: number | undefined
  for (const l of lines) {
    let m = /^Files:\s+(\d+)$/.exec(l)
    if (m) files = Number(m[1])
    m = /^Folders:\s+(\d+)$/.exec(l)
    if (m) folders = Number(m[1])
    m = /^Size:\s+(\d+)$/.exec(l)
    if (m) size = Number(m[1])
    m = /^Compressed:\s+(\d+)$/.exec(l)
    if (m) compressed = Number(m[1])
  }
  const errorLines = lines.filter(
    (l) =>
      /^ERROR:/i.test(l) ||
      /^Data Error/i.test(l) ||
      /^CRC Failed/i.test(l) ||
      /Wrong password/i.test(l) ||
      /^Cannot open/i.test(l) ||
      /^Cannot create/i.test(l) ||
      /^Cannot read/i.test(l)
  )
  const ok = exitCode === 0
  return { files, folders, size, compressed, hasErrors: !ok || errorLines.length > 0, errorLines }
}

// ---------------------------------------------------------------------------
// zstd
// ---------------------------------------------------------------------------

/** `zstd -lv` frame info; we only need whether a content checksum is present. */
export function parseZstdFrameHasChecksum(listOutput: string): boolean | undefined {
  const m = /^Frame Content Checksum:\s*(\S+)/m.exec(listOutput)
  if (!m) return undefined
  return m[1] === '1' || m[1] === 'XXH64' || m[1]?.toLowerCase() === 'yes'
}
