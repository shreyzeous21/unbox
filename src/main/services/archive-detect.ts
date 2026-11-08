/**
 * Archive detection: magic bytes first (authoritative), extension second,
 * and a decompressed-head peek for raw compressed streams to identify the
 * inner container (tar inside .gz/.bz2/.xz/.zst) without full passes.
 */
import { createReadStream } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import type { FormatId } from '@shared/formats'
import { EXTENSION_TO_FORMAT } from '@shared/formats'
import { engineBinary } from '@shared/env'

const READ_HEAD_BYTES = 600 // ustar magic lives at offset 257

export interface DetectionResult {
  format: FormatId | 'unknown'
  confidence: 'magic' | 'extension' | 'none'
  /** Set when the outer codec (gz/xz/…) wraps an inner container we identified. */
  innerFormat?: FormatId
}

async function readHead(filePath: string, bytes: number): Promise<Buffer> {
  const fd = createReadStream(filePath, { start: 0, end: bytes - 1 })
  const chunks: Buffer[] = []
  for await (const c of fd) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

/** Reads the file tail (for DMG 'koly' trailer). */
async function readTail(filePath: string, bytes: number, fileSize: number): Promise<Buffer> {
  const start = Math.max(0, fileSize - bytes)
  const fd = createReadStream(filePath, { start, end: fileSize - 1 })
  const chunks: Buffer[] = []
  for await (const c of fd) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

interface MagicMatch {
  format: FormatId
  confidence: 'magic'
}

export function magicFromHead(head: Buffer, fileSize: number): MagicMatch | null {
  // 7z
  if (head.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return { format: '7z', confidence: 'magic' }
  // zip (local file header) / empty zip EOCD / spanning marker
  if (
    head.subarray(0, 4).equals(Buffer.from('PK\x03\x04', 'binary')) ||
    head.subarray(0, 4).equals(Buffer.from('PK\x05\x06', 'binary')) ||
    head.subarray(0, 4).equals(Buffer.from('PK\x07\x08', 'binary'))
  ) {
    return { format: 'zip', confidence: 'magic' }
  }
  // RAR4 / RAR5
  if (head.subarray(0, 7).equals(Buffer.from('Rar!\x1a\x07\x00', 'binary'))) return { format: 'rar', confidence: 'magic' }
  if (head.subarray(0, 8).equals(Buffer.from('Rar!\x1a\x07\x01\x00', 'binary'))) return { format: 'rar', confidence: 'magic' }
  // gzip
  if (head[0] === 0x1f && head[1] === 0x8b) return { format: 'gz', confidence: 'magic' }
  // bzip2
  if (head.subarray(0, 3).toString('binary') === 'BZh') return { format: 'bz2', confidence: 'magic' }
  // xz
  if (head.subarray(0, 6).equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))) return { format: 'xz', confidence: 'magic' }
  // zstd (all four frame magics)
  if (head.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))) return { format: 'zst', confidence: 'magic' }
  // unix compress
  if (head[0] === 0x1f && head[1] === 0x9d) return { format: 'z', confidence: 'magic' }
  // LZMA alone format: properties byte + dict size + u64 size (0x5d common)
  if (head[0] === 0x5d && head[1] === 0x00 && head[2] === 0x00) return { format: 'lzma', confidence: 'magic' }
  // CAB
  if (head.subarray(0, 4).toString('binary') === 'MSCF') return { format: 'cab', confidence: 'magic' }
  // WIM (MSWIM\0\0\0 or WLPWM)
  if (head.subarray(0, 8).toString('binary') === 'MSWIM\x00\x00\x00' || head.subarray(0, 8).toString('binary') === 'WLPWM\x00\x00') {
    return { format: 'wim', confidence: 'magic' }
  }
  // ARJ
  if (head[0] === 0x60 && head[1] === 0xea) return { format: 'arj', confidence: 'magic' }
  // LZH: method string at offset 2, e.g. -lh5-
  if (head.subarray(2, 7).toString('binary').startsWith('-lh')) return { format: 'lzh', confidence: 'magic' }
  // XAR
  if (head.subarray(0, 4).toString('binary') === 'xar!') return { format: 'xar', confidence: 'magic' }
  // CFBF (MSI)
  if (head.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    return { format: 'msi', confidence: 'magic' }
  }
  // RPM
  if (head.subarray(0, 4).equals(Buffer.from([0xed, 0xab, 0xee, 0xdb]))) return { format: 'rpm', confidence: 'magic' }
  // deb (ar archive)
  if (head.subarray(0, 8).toString('binary') === '!<arch>\n') return { format: 'deb', confidence: 'magic' }
  // cpio
  if (head.subarray(0, 6).toString('binary') === '070701' || head.subarray(0, 6).toString('binary') === '070707') {
    return { format: 'cpio', confidence: 'magic' }
  }
  // tar: ustar at 257, or old-style tar (checksum heuristic via 512-block zeros)
  if (head.length > 262 && head.subarray(257, 262).toString('binary') === 'ustar') {
    return { format: 'tar', confidence: 'magic' }
  }
  // DMG koly trailer
  if (fileSize > 512 && head.length === 0) {
    // handled by caller via tail read
  }
  return null
}

/**
 * Peeks the inner content of a raw compressed stream by decoding just the
 * first kilobyte. Uses the system decompressor and a short read so the
 * decoder dies on SIGPIPE after emitting a few KB — this never reads the
 * whole archive.
 */
async function peekInnerFormat(archivePath: string, format: FormatId): Promise<FormatId | null> {
  // Decode only the first few hundred bytes, then SIGKILL the decoder.
  // The pipe closes, the decoder dies on SIGPIPE; we never read the archive.
  const probe = spawn(decoderFor(format), ['-dc', archivePath], { stdio: ['ignore', 'pipe', 'ignore'] })
  let collected = Buffer.alloc(0)
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      probe.kill('SIGKILL')
      resolve()
    }, 4000)
    probe.stdout?.on('data', (chunk: Buffer) => {
      collected = Buffer.concat([collected, chunk])
      if (collected.length >= READ_HEAD_BYTES) {
        clearTimeout(timer)
        probe.kill('SIGKILL')
        resolve()
      }
    })
    probe.stdout?.on('end', () => {
      clearTimeout(timer)
      resolve()
    })
    probe.stdout?.on('error', () => {
      clearTimeout(timer)
      resolve()
    })
    probe.on('error', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  if (collected.length === 0) return null
  if (collected.subarray(257, 262).toString('binary') === 'ustar') return 'tar'
  if (collected.subarray(0, 6).toString('binary') === '070701') return 'cpio'
  // Single inner file (e.g. data.txt.gz): keep the raw codec format.
  return null
}

function decoderFor(format: FormatId): string {
  switch (format) {
    case 'gz':
      return '/usr/bin/gzip'
    case 'bz2':
      return '/usr/bin/bzip2'
    case 'xz':
      return '/usr/bin/xz'
    case 'zst':
      return engineBinary('zstd')
    default:
      return '/bin/cat'
  }
}

export async function detectArchiveFormat(filePath: string, fileSize?: number): Promise<DetectionResult> {
  let size = fileSize
  if (size === undefined) {
    try {
      const { statSync } = await import('node:fs')
      size = statSync(filePath).size
    } catch {
      return { format: 'unknown', confidence: 'none' }
    }
  }
  const head = await readHead(filePath, READ_HEAD_BYTES)

  const magic = magicFromHead(head, size)
  let base: FormatId | 'unknown' = 'unknown'
  let confidence: 'magic' | 'extension' | 'none' = 'none'

  if (magic) {
    base = magic.format
    confidence = 'magic'
  } else if (size >= 512) {
    // DMG: 'koly' magic is in the last 512 bytes.
    const tail = await readTail(filePath, 512, size)
    if (tail.subarray(0, 4).toString('binary') === 'koly') {
      return { format: 'dmg', confidence: 'magic' }
    }
  }

  if (base === 'unknown') {
    const ext = pickExtensionFormat(filePath)
    if (ext) {
      base = ext
      confidence = 'extension'
    }
  }

  if (base === 'gz' || base === 'bz2' || base === 'xz' || base === 'zst') {
    // Compound? Peek inside the decoded head.
    const inner = await peekInnerFormat(filePath, base)
    if (inner === 'tar') {
      const compound: Record<string, FormatId> = {
        gz: 'tar-gz', bz2: 'tar-bz2', xz: 'tar-xz', zst: 'tar-zst'
      }
      return { format: compound[base] ?? base, confidence, innerFormat: 'tar' }
    }
    if (inner === 'cpio') return { format: base, confidence, innerFormat: 'cpio' }
  }

  return { format: base, confidence }
}

function pickExtensionFormat(filePath: string): FormatId | null {
  const name = path.basename(filePath).toLowerCase()
  // Longest-match against the shared table (handles .tar.gz vs .gz, .part1.rar, .7z.001).
  const candidates = [...EXTENSION_TO_FORMAT.entries()].sort((a, b) => b[0].length - a[0].length)
  for (const [ext, format] of candidates) {
    if (name.endsWith(ext)) return format
  }
  return null
}
