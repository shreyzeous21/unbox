/**
 * Engine integration tests — REAL vendored engines against REAL archives,
 * verified by SHA-256 round-trip. These tests exercise the actual 7zz /
 * bsdtar / zstd binaries in resources/bin.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  buildSourceTree, CREATORS, EXT_FOR_NAME, createSplit7z, corruptMiddle, createZipSlipArchive,
  createZipControlCharArchive, haveEngine, SEVENZIP, ZSTD, tmpRoot, truncate, verifyTree,
  type SourceManifest
} from '../fixtures/builders'
import { sevenZip } from '../../src/main/services/engines/sevenzip'
import { libarchive } from '../../src/main/services/engines/libarchive'
import { zstdEngine } from '../../src/main/services/engines/zstd'
import { detectArchiveFormat } from '../../src/main/services/archive-detect'
import type { Engine } from '../../src/main/services/engines/engine-types'

const fixtureDir = tmpRoot('fx')
let manifest: SourceManifest

beforeAll(async () => {
  manifest = await buildSourceTree(path.join(fixtureDir, 'src'), { withSymlink: true, nested: 30 })
  // Create every archive we can create with available tooling.
  for (const [name, create] of Object.entries(CREATORS)) {
    const ext = EXT_FOR_NAME[name] ?? name
    create(path.join(fixtureDir, `arch-${name}.${ext}`), manifest.root)
  }
})

afterAll(async () => {
  await fsp.rm(fixtureDir, { recursive: true, force: true })
})

const HAS_7ZZ = haveEngine(SEVENZIP)
const HAS_ZSTD = haveEngine(ZSTD)

/** Extracts with an engine and verifies SHA-256 round-trip against the source manifest. */
async function expectRoundTrip(engine: Engine, archivePath: string, password?: string): Promise<void> {
  const outDir = path.join(fixtureDir, `out-${path.basename(archivePath)}-${Math.random().toString(36).slice(2, 6)}`)
  await fsp.mkdir(outDir, { recursive: true })
  const result = await engine.extract(archivePath, { outDir, password })
  expect(result.ok, `engine reported failure: ${JSON.stringify(result.issues)}`).toBe(true)
  // Source entries were created with a leading './' via 7zz; both rootings OK —
  // find the manifest root inside the output.
  const base = await findManifestBase(outDir)
  const problems = await verifyTree(base, manifest)
  expect(problems, problems.join('\n')).toEqual([])
  await fsp.rm(outDir, { recursive: true, force: true })
}

/** Archives created with `-C`-style '.' prefix may nest sources one level. */
async function findManifestBase(outDir: string): Promise<string> {
  // If a.txt sits directly in outDir → base is outDir; if a single dir contains it → that dir.
  if (fs.existsSync(path.join(outDir, 'a.txt'))) return outDir
  const entries = await fsp.readdir(outDir)
  for (const e of entries) {
    const p = path.join(outDir, e)
    if (fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'a.txt'))) return p
  }
  return outDir
}

describe('archive detection (magic bytes)', () => {
  it('detects zip / 7z / rar-less formats by magic', async () => {
    for (const [file, expected] of [
      ['arch-zip.zip', 'zip'],
      ['arch-7z.7z', '7z'],
      ['arch-tar.tar', 'tar'],
      ['arch-tar.gz.tar.gz', 'tar-gz'],
      ['arch-tar.zst.tar.zst', 'tar-zst'],
      ['arch-gz-single.gz', 'gz']
    ] as const) {
      const p = path.join(fixtureDir, file)
      if (!fs.existsSync(p)) continue
      const det = await detectArchiveFormat(p)
      expect(det.format, `${file} → ${det.format}`).toBe(expected)
      expect(det.confidence).toBe('magic')
    }
  })

  it('detects ustar content by magic even without extension', async () => {
    const src = path.join(fixtureDir, 'arch-tar.tar')
    const dst = path.join(fixtureDir, 'noext-detect.bin')
    await fsp.copyFile(src, dst)
    const det = await detectArchiveFormat(dst)
    expect(det.format).toBe('tar')
    expect(det.confidence).toBe('magic')
  })
})

describe('7zz engine', () => {
  it.skipIf(!HAS_7ZZ)('reports version', async () => {
    expect(await sevenZip.version()).toMatch(/^\d/)
  })

  const zipCases: Array<[string, string, string?]> = [
    ['arch-zip.zip', 'zip'],
    ['arch-zip-store.zip', 'zip'],
    ['arch-7z.7z', '7z'],
    ['arch-enc-zip.zip', 'zip', 'TestPass123!'],
    ['arch-enc-7z.7z', '7z', 'TestPass123!']
  ]

  it.skipIf(!HAS_7ZZ)('lists and extracts with SHA-256 round-trip', async () => {
    for (const [file, format, password] of zipCases) {
      const p = path.join(fixtureDir, file)
      if (!fs.existsSync(p)) continue
      const list = await sevenZip.list(p, { password })
      expect(list.fileCount, file).toBeGreaterThanOrEqual(31)
      if (format !== 'tar') {
        // cheap-list formats know sizes upfront
        expect(list.totalUncompressed, file).toBeGreaterThan(manifest.totalBytes - 4096)
      }
      await expectRoundTrip(sevenZip, p, password)
    }
  })

  it.skipIf(!HAS_7ZZ)('pre-test passes on good archives and catches corruption', async () => {
    const good = path.join(fixtureDir, 'arch-7z.7z')
    const t1 = await sevenZip.test!(good, {})
    expect(t1.ok).toBe(true)

    const bad = path.join(fixtureDir, 'corrupt-7z.7z')
    await fsp.copyFile(good, bad)
    await corruptMiddle(bad, 512)
    const t2 = await sevenZip.test!(bad, {})
    expect(t2.ok).toBe(false)
    expect(t2.issues.some((i) => i.severity === 'error')).toBe(true)
  })

  it.skipIf(!HAS_7ZZ)('fails with WRONG_PASSWORD on bad password', async () => {
    const p = path.join(fixtureDir, 'arch-enc-7z.7z')
    const result = await sevenZip.extract(p, {
      outDir: path.join(fixtureDir, 'out-badpw'),
      password: 'definitely-wrong'
    })
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.code === 'WRONG_PASSWORD')).toBe(true)
  })

  it.skipIf(!HAS_7ZZ)('extracts split .7z.001 volumes when complete', async () => {
    const first = createSplit7z(path.join(fixtureDir, 'split'), manifest.root, 50_000)
    await expectRoundTrip(sevenZip, first)
  })

  it.skipIf(!HAS_7ZZ)('reports a clear error when a volume is missing', async () => {
    const first = createSplit7z(path.join(fixtureDir, 'incomplete'), manifest.root, 50_000)
    // Delete the second volume, keep .001.
    const second = first.replace(/\.001$/, '.002')
    if (fs.existsSync(second)) await fsp.rm(second)
    const outDir = path.join(fixtureDir, 'out-incomplete-split')
    await fsp.mkdir(outDir, { recursive: true })
    const result = await sevenZip.extract(first, { outDir })
    expect(result.ok).toBe(false)
    expect(result.issues.length).toBeGreaterThan(0)
    await fsp.rm(outDir, { recursive: true, force: true })
  })

  it.skipIf(!HAS_7ZZ)('extraction catches CRC corruption', async () => {
    const good = path.join(fixtureDir, 'arch-zip-store.zip')
    const bad = path.join(fixtureDir, 'corrupt-zip.zip')
    await fsp.copyFile(good, bad)
    await corruptMiddle(bad, 256)
    const outDir = path.join(fixtureDir, 'out-corrupt-zip')
    await fsp.mkdir(outDir, { recursive: true })
    const result = await sevenZip.extract(bad, { outDir })
    expect(result.ok).toBe(false)
    const codes = result.issues.map((i) => i.code)
    expect(codes.some((c) => ['CRC_FAILED', 'DATA_ERROR', 'TRUNCATED', 'ENGINE_ERROR'].includes(c))).toBe(true)
    await fsp.rm(outDir, { recursive: true, force: true })
  })
})

describe('libarchive engine (bsdtar)', () => {
  it('lists and extracts tar family with SHA-256 round-trip', async () => {
    for (const file of ['arch-tar.tar', 'arch-tar.gz.tar.gz', 'arch-tar.bz2.tar.bz2', 'arch-tar.xz.tar.xz']) {
      const p = path.join(fixtureDir, file)
      if (!fs.existsSync(p)) continue
      const list = await libarchive.list(p)
      expect(list.fileCount, file).toBeGreaterThanOrEqual(31)
      if (file === 'arch-tar.tar') {
        expect(list.totalUncompressed).toBeGreaterThan(manifest.totalBytes - 4096)
      }
      await expectRoundTrip(libarchive, p)
    }
  })

  it('extracts from a piped stdin tar (zstd→bsdtar path uses the same mechanics)', async () => {
    // zstd CLI output piped into bsdtar stdin — direct test of the pipe stage.
    if (!HAS_ZSTD) return
    const zst = path.join(fixtureDir, 'pipe.tar.zst')
    const tmpTar = path.join(fixtureDir, 'pipe.tmp.tar')
    const { execFileSync } = await import('node:child_process')
    execFileSync('/usr/bin/tar', ['-cf', tmpTar, '-C', manifest.root, '.'])
    execFileSync(ZSTD, ['-f', tmpTar, '-o', zst])
    fs.rmSync(tmpTar)

    const outDir = path.join(fixtureDir, 'out-pipe')
    await fsp.mkdir(outDir, { recursive: true })
    const result = await zstdEngine.extract(zst, { outDir })
    expect(result.ok, JSON.stringify(result.issues)).toBe(true)
    const problems = await verifyTree(outDir, manifest)
    expect(problems).toEqual([])
  })
})

describe('zstd engine', () => {
  it.skipIf(!HAS_ZSTD)('decodes .tar.zst with SHA-256 round-trip', async () => {
    await expectRoundTrip(zstdEngine, path.join(fixtureDir, 'arch-tar.zst.tar.zst'))
  })

  it.skipIf(!HAS_ZSTD)('detects corruption in zstd frames', async () => {
    const bad = path.join(fixtureDir, 'corrupt.tar.zst')
    await fsp.copyFile(path.join(fixtureDir, 'arch-tar.zst.tar.zst'), bad)
    await corruptMiddle(bad, 128)
    const outDir = path.join(fixtureDir, 'out-corrupt-zst')
    await fsp.mkdir(outDir, { recursive: true })
    const result = await zstdEngine.extract(bad, { outDir })
    expect(result.ok).toBe(false)
    await fsp.rm(outDir, { recursive: true, force: true })
  })

  it.skipIf(!HAS_ZSTD)('decodes single-file .zst', async () => {
    const { execFileSync } = await import('node:child_process')
    const zst = path.join(fixtureDir, 'single.txt.zst')
    execFileSync(ZSTD, ['-f', path.join(fixtureDir, 'src/a.txt'), '-o', zst])
    const outDir = path.join(fixtureDir, 'out-single-zst')
    await fsp.mkdir(outDir, { recursive: true })
    const result = await zstdEngine.extract(zst, { outDir })
    expect(result.ok).toBe(true)
    expect(result.bytesWritten).toBe(21) // 'hello unbox\nline two\n'
    await fsp.rm(outDir, { recursive: true, force: true })
  })
})

describe('malicious and hostile archives (refused, never extracted)', () => {
  it('refuses ZIP-slip traversal entries before extraction', async () => {
    const evil = path.join(fixtureDir, 'evil-traversal.zip')
    await createZipSlipArchive(evil)
    // Listing detects the violation.
    const list = await sevenZip.list(evil)
    const violations = list.entries.filter((e) => e.name.includes('..') || e.name.startsWith('/'))
    expect(violations.length).toBeGreaterThanOrEqual(2)

    // Direct extraction would write OUTSIDE the target dir; the engine must
    // be preceded by validation in the job runner, but even raw 7zz behavior
    // is 'strips the prefix' — our validator refuses the archive entirely.
    const { validateListing } = await import('../../src/main/services/fs-safety')
    const names = validateListing(list.entries.map((e) => e.name))
    expect(names.length).toBeGreaterThanOrEqual(2)
  })

  it('rejects control-character entry names', async () => {
    const evil = path.join(fixtureDir, 'evil-ctrl.zip')
    await createZipControlCharArchive(evil)
    const list = await sevenZip.list(evil)
    const { checkEntryName } = await import('../../src/main/services/fs-safety')
    const bad = list.entries.some((e) => checkEntryName(e.name).violation)
    expect(bad).toBe(true)
  })
})

describe('truncated archives', () => {
  it.skipIf(!HAS_7ZZ)('fail loudly instead of pretending success', async () => {
    const p = path.join(fixtureDir, 'truncated.zip')
    await fsp.copyFile(path.join(fixtureDir, 'arch-zip-store.zip'), p)
    await truncate(p, 0.4)
    const outDir = path.join(fixtureDir, 'out-truncated')
    await fsp.mkdir(outDir, { recursive: true })
    const result = await sevenZip.extract(p, { outDir })
    expect(result.ok).toBe(false)
    await fsp.rm(outDir, { recursive: true, force: true })
  })
})

describe('cancellation', () => {
  it.skipIf(!HAS_7ZZ)('aborts a running extraction promptly', async () => {
    // Make a big archive so extraction takes measurable time.
    const bigDir = path.join(fixtureDir, 'big-src')
    await fsp.mkdir(bigDir, { recursive: true })
    const { seededBigFile } = await import('../fixtures/builders-helpers')
    await seededBigFile(path.join(bigDir, 'big.bin'), 2560 * 1024 * 1024)
    const bigZip = path.join(fixtureDir, 'big.zip')
    const { execFileSync } = await import('node:child_process')
    execFileSync(SEVENZIP, ['a', '-tzip', '-mx0', bigZip, path.join(bigDir, '.')], { stdio: 'pipe' })

    const outDir = path.join(fixtureDir, 'out-cancel')
    await fsp.mkdir(outDir, { recursive: true })
    const controller = new AbortController()
    const started = Date.now()
    setTimeout(() => controller.abort(), 300)
    const result = await sevenZip.extract(bigZip, { outDir, signal: controller.signal })
    const elapsed = Date.now() - started
    expect(result.cancelled).toBe(true)
    expect(elapsed).toBeLessThan(8000)
    await fsp.rm(outDir, { recursive: true, force: true })
    await fsp.rm(bigZip, { force: true })
    await fsp.rm(bigDir, { recursive: true, force: true })
  }, 120_000)
})
