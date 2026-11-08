/**
 * Test fixture builders — deterministic source trees with SHA-256 manifests,
 * archives created with the REAL vendored engines, and corruption helpers.
 *
 * Every archive assertion verifies extracted bytes against cryptographic
 * hashes of the source content. No placeholder data.
 */
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const SEVENZIP = path.join(REPO_ROOT, 'resources/bin/7zz')
export const ZSTD = path.join(REPO_ROOT, 'resources/bin/zstd')
export const BSDTAR = '/usr/bin/bsdtar'

export function haveEngine(bin: string): boolean {
  return fs.existsSync(bin)
}

/** Deterministic PRNG content (xorshift) — compressible pattern, reproducible. */
function seededChunk(seed: number, size: number): Buffer {
  const buf = Buffer.allocUnsafe(size)
  let state = seed >>> 0
  for (let i = 0; i < size; i++) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    buf[i] = state & 0xff
  }
  return buf
}

export interface SourceManifest {
  root: string
  /** relPath → sha256 of source content */
  files: Map<string, string>
  totalBytes: number
}

/**
 * Builds a deterministic source tree:
 *   a.txt (small text), unicode dir names, nested dirs, binary blobs,
 *   an empty dir, and (optionally) a symlink.
 */
export async function buildSourceTree(
  root: string,
  opts: { withSymlink?: boolean; binarySize?: number; nested?: number } = {}
): Promise<SourceManifest> {
  await fsp.mkdir(root, { recursive: true })
  const files = new Map<string, string>()
  let totalBytes = 0

  const write = async (rel: string, content: Buffer | string): Promise<void> => {
    const full = path.join(root, rel)
    await fsp.mkdir(path.dirname(full), { recursive: true })
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
    await fsp.writeFile(full, buf)
    files.set(rel, createHash('sha256').update(buf).digest('hex'))
    totalBytes += buf.length
  }

  await write('a.txt', 'hello unbox\nline two\n')
  await write('notes/日本語-ünïcode-ⓤⓝⓘⓒⓞⓓⓔ.txt', 'unicode names must survive round-trips ✓\n')
  await write('notes/deep/deeper/deepest/leaf.bin', seededChunk(42, opts.binarySize ?? 256 * 1024))
  await write('top.bin', seededChunk(1337, (opts.binarySize ?? 256 * 1024) * 2))
  const nested = opts.nested ?? 40
  for (let i = 0; i < nested; i++) {
    await write(`many/file-${String(i).padStart(4, '0')}.dat`, seededChunk(1000 + i, 1024))
  }
  await fsp.mkdir(path.join(root, 'empty-dir'), { recursive: true })
  if (opts.withSymlink) {
    await fsp.symlink('a.txt', path.join(root, 'link-to-a'))
  }

  return { root, files, totalBytes }
}

export type ArchiveCreator = (archivePath: string, sourceRoot: string) => void

function sevenzipArgsSwitches(switches: string[]): ArchiveCreator {
  return (archivePath, sourceRoot) => {
    execFileSync(SEVENZIP, ['a', ...switches, archivePath, path.join(sourceRoot, '.')], { stdio: 'pipe' })
  }
}

export const CREATORS: Record<string, ArchiveCreator> = {
  'zip': sevenzipArgsSwitches(['-tzip']),
  'zip-store': sevenzipArgsSwitches(['-tzip', '-mx0']),
  '7z': sevenzipArgsSwitches(['-t7z']),
  'tar': (a, s) => execFileSync(BSDTAR, ['-cf', a, '-C', s, '.'], { stdio: 'pipe' }),
  'tar.gz': (a, s) => execFileSync(BSDTAR, ['-czf', a, '-C', s, '.'], { stdio: 'pipe' }),
  'tar.bz2': (a, s) => execFileSync(BSDTAR, ['-cjf', a, '-C', s, '.'], { stdio: 'pipe' }),
  'tar.xz': (a, s) => execFileSync(BSDTAR, ['--xz', '-cf', a, '-C', s, '.'], { stdio: 'pipe' }),
  'tar.zst': (a, s) => {
    const tmpTar = a.replace(/\.tar\.zst$/, '.tmp.tar')
    execFileSync(BSDTAR, ['-cf', tmpTar, '-C', s, '.'], { stdio: 'pipe' })
    execFileSync(ZSTD, ['-f', '-3', tmpTar, '-o', a], { stdio: 'pipe' })
    fs.rmSync(tmpTar)
  },
  'gz-single': (a, s) => execFileSync('/usr/bin/gzip', ['-c'], { input: fs.readFileSync(path.join(s, 'a.txt')), stdio: ['pipe', fs.openSync(a, 'w'), 'pipe'] }),
  'enc-7z': (a, s) => execFileSync(SEVENZIP, ['a', '-t7z', '-pTestPass123!', '-mhe=on', a, path.join(s, '.')], { stdio: 'pipe' }),
  'enc-zip': (a, s) => execFileSync(SEVENZIP, ['a', '-tzip', '-pTestPass123!', a, path.join(s, '.')], { stdio: 'pipe' })
}

/** Fixture filename extension per creator key. */
export const EXT_FOR_NAME: Record<string, string> = {
  'zip': 'zip',
  'zip-store': 'zip',
  '7z': '7z',
  'tar': 'tar',
  'tar.gz': 'tar.gz',
  'tar.bz2': 'tar.bz2',
  'tar.xz': 'tar.xz',
  'tar.zst': 'tar.zst',
  'gz-single': 'gz',
  'enc-7z': '7z',
  'enc-zip': 'zip'
}

/** Split .7z.001/.002 volumes. Returns the first-volume path. */
export function createSplit7z(archiveBase: string, sourceRoot: string, volumeBytes = 50_000): string {
  execFileSync(SEVENZIP, ['a', '-t7z', `-v${volumeBytes}`, `${archiveBase}.7z`, path.join(sourceRoot, '.')], { stdio: 'pipe' })
  return `${archiveBase}.7z.001`
}

/** Corrupts `count` bytes in the middle of a file. */
export async function corruptMiddle(archivePath: string, count = 64): Promise<void> {
  const st = await fsp.stat(archivePath)
  const fh = await fsp.open(archivePath, 'r+')
  try {
    const pos = Math.floor(st.size / 2)
    const garbage = randomBytes(count)
    await fh.write(garbage, 0, count, pos)
  } finally {
    await fh.close()
  }
}

/** Truncates an archive to a fraction of its size. */
export async function truncate(archivePath: string, fraction: number): Promise<void> {
  const st = await fsp.stat(archivePath)
  await fsp.truncate(archivePath, Math.floor(st.size * fraction))
}

export function tmpRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `unbox-test-${prefix}-`))
}

export function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/**
 * Verifies an extracted tree against the source manifest. Returns list of
 * mismatches (empty = byte-perfect round trip).
 */
export async function verifyTree(extractedRoot: string, manifest: SourceManifest): Promise<string[]> {
  const problems: string[] = []
  for (const [rel, expectedHash] of manifest.files) {
    const full = path.join(extractedRoot, rel)
    try {
      const got = sha256File(full)
      if (got !== expectedHash) problems.push(`hash mismatch: ${rel}`)
    } catch {
      problems.push(`missing: ${rel}`)
    }
  }
  return problems
}

/**
 * Builds a zip containing traversal entries ("../evil.txt") using raw zip
 * structures via the system python (no third-party deps). This is the
 * malicious-archive fixture for the ZIP-slip test.
 */
export async function createZipSlipArchive(outPath: string): Promise<void> {
  const script = `
import zipfile, sys
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    z.writestr('../unbox-evil-payload.txt', 'malicious content')
    z.writestr('ok.txt', 'fine content')
    z.writestr('a/../../unbox-evil-2.txt', 'malicious content 2')
`
  execFileSync('/usr/bin/python3', ['-I', '-c', script, outPath], { stdio: 'pipe' })
}

/** Zip with a control-character entry name (NUL is illegal even to python's zipfile). */
export async function createZipControlCharArchive(outPath: string): Promise<void> {
  const script = `
import zipfile, sys
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    zi = zipfile.ZipInfo('bad\u0007name.txt')
    zi.external_attr = 0o644 << 16
    z.writestr(zi, 'content')
`
  execFileSync('/usr/bin/python3', ['-I', '-c', script, outPath], { stdio: 'pipe' })
}
