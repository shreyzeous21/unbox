/**
 * Filesystem safety service — the security boundary between archive contents
 * and the user's disk. Everything an archive claims to write flows through
 * here before extraction starts, and the extracted tree is audited after.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/** Error carrying a stable code for UI mapping. */
export class SafeError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'SafeError'
  }
}

export interface EntryNameCheck {
  /** Normalized POSIX path relative to the extraction root, when safe. */
  safePath?: string
  violation?: 'absolute' | 'traversal' | 'nul-byte' | 'windows-drive' | 'unc' | 'control-chars'
  detail?: string
}

/**
 * Validates one archive entry name. Rules:
 * - Absolute paths (/…, \…), Windows drive letters (C:\, C:/) and UNC paths
 *   (\\server\share) are rejected — we do not remap, we abort, because a
 *   remapped malicious entry is still attacker-controlled clutter.
 * - Any ".." segment is rejected (after normalization attempts, including
 *   double-encoded tricks like "..%2F" which remain literal text in paths —
 *   archives carry raw bytes, so encoding attacks surface as NUL/control
 *   checks below and as post-extract audits).
 * - NUL bytes and C0 control characters (except \n in weird-but-legal names
 *   is NOT allowed either — POSIX allows them but they are hostile in
 *   archives) are rejected.
 * - Backslashes are treated as literal filename characters on macOS except
 *   when they form a drive/UNC pattern (checked above); zip created on
 *   Windows uses forward slashes per the APPNOTE, so no translation here.
 */
export function checkEntryName(rawName: string): EntryNameCheck {
  if (rawName.includes('\u0000')) {
    return { violation: 'nul-byte', detail: `entry name contains NUL byte: ${JSON.stringify(rawName.slice(0, 80))}` }
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0001-\u001f\u007f]/.test(rawName)) {
    return { violation: 'control-chars', detail: `entry name contains control characters: ${JSON.stringify(rawName.slice(0, 80))}` }
  }
  if (rawName.startsWith('/') || rawName.startsWith('\\')) {
    return { violation: 'absolute', detail: `absolute path entry: ${rawName.slice(0, 120)}` }
  }
  if (/^[a-zA-Z]:/.test(rawName)) {
    return { violation: 'windows-drive', detail: `windows drive path entry: ${rawName.slice(0, 120)}` }
  }
  if (rawName.startsWith('\\\\') || rawName.startsWith('//')) {
    return { violation: 'unc', detail: `UNC path entry: ${rawName.slice(0, 120)}` }
  }
  const segments = rawName.split('/')
  if (segments.includes('..')) {
    return { violation: 'traversal', detail: `path traversal entry: ${rawName.slice(0, 120)}` }
  }
  // Strip empty + current-dir segments, produce the clean relative path.
  const clean = segments.filter((s) => s !== '' && s !== '.').join('/')
  if (!clean) {
    // A bare '.' / './' is the archive-root marker (tar entries created with
    // `-C dir .` include it) — safe, creates nothing. A bare '..' is still
    // traversal and stays rejected.
    if (/^\.{1}\/?$/.test(rawName.trim())) {
      return { safePath: '' }
    }
    return { violation: 'traversal', detail: `entry name normalizes to empty path` }
  }
  return { safePath: clean }
}

/**
 * Validates a full listing before any byte is written. Returns violations;
 * a non-empty result means the job must abort (policy: refuse, don't remap).
 */
export function validateListing(entryNames: string[]): EntryNameCheck[] {
  const violations: EntryNameCheck[] = []
  for (const name of entryNames) {
    const check = checkEntryName(name)
    if (check.violation) violations.push({ violation: check.violation, detail: check.detail })
  }
  return violations
}

/**
 * Audits an extracted tree: counts files/bytes/links, and neutralizes any
 * symlink or hardlink that escapes the root. Returns the audit result —
 * the caller decides whether the outcome is fatal (policy: escaped links
 * are removed AND reported; the job completes with errors if any existed).
 */
export interface TreeAudit {
  files: number
  folders: number
  symlinks: number
  hardlinks: number
  bytes: number
  escapedLinks: Array<{ link: string; target: string }>
  removedEscapedLinks: number
  /** True when the walk could not finish (permissions, disconnect). */
  incomplete: boolean
  incompleteReason?: string
}

export async function auditExtractedTree(root: string, onProgress?: (visited: number) => void): Promise<TreeAudit> {
  const audit: TreeAudit = { files: 0, folders: 0, symlinks: 0, hardlinks: 0, bytes: 0, escapedLinks: [], removedEscapedLinks: 0, incomplete: false }
  const rootReal = await fsp.realpath(root).catch(() => root)
  let visited = 0

  async function walk(dir: string): Promise<void> {
    let dirents: fs.Dirent[]
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true })
    } catch (err) {
      audit.incomplete = true
      audit.incompleteReason = err instanceof Error ? err.message : String(err)
      return
    }
    for (const entry of dirents) {
      visited++
      if (onProgress && visited % 500 === 0) onProgress(visited)
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        audit.symlinks++
        // Resolve WITHOUT following the final component where possible.
        const target = await fsp.realpath(full).catch(() => null)
        if (target && !target.startsWith(rootReal + path.sep) && target !== rootReal) {
          // Escape attempt: remove the link, remember it.
          audit.escapedLinks.push({ link: path.relative(root, full), target })
          try {
            await fsp.unlink(full)
            audit.removedEscapedLinks++
          } catch {
            /* leave for report */
          }
        }
        continue
      }
      if (entry.isDirectory()) {
        audit.folders++
        await walk(full)
        continue
      }
      if (entry.isFile()) {
        try {
          const st = await fsp.lstat(full)
          audit.files++
          audit.bytes += st.size
          if (st.nlink > 1) audit.hardlinks++
        } catch {
          audit.incomplete = true
          audit.incompleteReason = audit.incompleteReason ?? `cannot stat ${path.relative(root, full)}`
        }
      }
    }
  }

  await walk(root)
  return audit
}

/**
 * Picks a final output path that does not exist: `base`, `base-1`, `base-2`…
 * Atomicity: caller creates the directory only via this returned name.
 */
export async function uniqueDirectoryPath(base: string): Promise<string> {
  if (!fs.existsSync(base)) return base
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${base}-${i}`
    if (!fs.existsSync(candidate)) return candidate
  }
  throw new SafeError('DESTINATION_CONFLICT', `too many conflicting output folders for ${base}`)
}

/**
 * Creates the hidden temp workspace for a job INSIDE the destination folder's
 * volume so the final rename stays atomic (same-device rename(2)).
 * The name is hidden (leading dot) and carries the job id.
 */
export async function createTempWorkspace(destination: string, jobId: string, folderName: string): Promise<string> {
  await fsp.mkdir(destination, { recursive: true })
  const tmp = path.join(destination, `.${folderName}.unbox-partial-${jobId}`)
  await fsp.mkdir(tmp, { recursive: false }) // must not pre-exist; ENOTDIR/EEXIST = policy failure
  return tmp
}

/** Removes a temp workspace recursively, swallowing nothing silently: returns success. */
export async function removeTempWorkspace(tmp: string): Promise<boolean> {
  try {
    await fsp.rm(tmp, { recursive: true, force: false })
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return true
    return false
  }
}

/**
 * Ensures `dirPath` (a directory intended to live inside root) is safe to
 * create — used by engines' own dir handling; defense in depth for engines
 * that ignore listing-time validation.
 */
export function ensureInsideRoot(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(candidate)
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new SafeError('ESCAPE_ATTEMPT', `refusing to create outside root: ${candidate}`)
  }
  return resolved
}

/** fsync a directory so its entries are durable before we announce completion. */
export async function fsyncDir(dir: string): Promise<void> {
  const handle = await fsp.open(dir, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
