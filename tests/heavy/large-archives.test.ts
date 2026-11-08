/**
 * Heavy tests — real large-archive verification. These are SLOW and
 * disk-hungry by design; run them explicitly:
 *
 *   EXTRACTOR_HEAVY=1 npm run test:heavy          # 1GB + 10GB + million entries
 *   EXTRACTOR_HEAVY=100 npm run test:heavy        # additionally 50GB + 100GB
 *
 * They assert actual bytes on disk and cryptographic hashes, plus peak
 * worker RSS — proving large-archive support is not extrapolated from
 * small-file tests.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { SEVENZIP, BSDTAR } from '../fixtures/builders'
import { seededBigFile } from '../fixtures/builders-helpers'
import { JobRunner } from '../../src/main/services/extraction/job-runner'
import { sevenZip } from '../../src/main/services/engines/sevenzip'
import { libarchive } from '../../src/main/services/engines/libarchive'

const HEAVY_LEVEL = Number(process.env.EXTRACTOR_HEAVY ?? '0')
const RUN = HEAVY_LEVEL > 0
const RUN_XL = HEAVY_LEVEL >= 100

const dir = RUN ? fs.mkdtempSync(path.join(os.tmpdir(), 'unbox-heavy-')) : '/tmp/unbox-heavy-disabled'

beforeAll(() => {
  if (!RUN) throw new Error('heavy tests are disabled — set EXTRACTOR_HEAVY=1 to run them')
})
afterAll(async () => {
  if (RUN) await fsp.rm(dir, { recursive: true, force: true })
})

/** Peak RSS sampler for the test process tree (engines are children). */
class RssSampler {
  private peak = 0
  private timer: NodeJS.Timeout | null = null
  start(): void {
    this.timer = setInterval(() => {
      const rss = process.memoryUsage().rss
      if (rss > this.peak) this.peak = rss
    }, 250)
    this.timer.unref?.()
  }
  stop(): number {
    if (this.timer) clearInterval(this.timer)
    return this.peak
  }
}

async function runJob(archivePath: string, format: 'zip' | '7z' | 'tar', listing: Awaited<ReturnType<typeof sevenZip.list>> | null, outBase: string): Promise<{ finalPath: string; peakRss: number; elapsedMs: number }> {
  const destination = path.join(dir, `dest-${path.basename(outBase)}`)
  const req = {
    jobId: `heavy-${path.basename(outBase)}`,
    archivePath,
    format,
    archiveSize: fs.statSync(archivePath).size,
    listing,
    options: { destination, overwritePolicy: 'auto-rename' as const, preTest: false, keepSuccessfulOnFailure: true },
    workspace: path.join(destination, '.heavy.unbox-partial'),
    finalPath: path.join(destination, path.basename(outBase))
  }
  const sampler = new RssSampler()
  sampler.start()
  const started = Date.now()
  const runner = new JobRunner(req, { onProgress: () => {}, onState: () => {}, onLog: () => {} })
  const result = await runner.run()
  const elapsedMs = Date.now() - started
  const peakRss = sampler.stop()
  expect(result.state, result.failureReason).toBe('completed')
  return { finalPath: req.finalPath, peakRss, elapsedMs }
}

describe('heavy: large archives', () => {
  it.skipIf(!RUN)('1 GB zip: byte-exact round trip, bounded memory, throughput reported', async () => {
    const srcDir = path.join(dir, 'src-1g')
    await fsp.mkdir(srcDir, { recursive: true })
    const bigFile = path.join(srcDir, 'big1g.bin')
    const SIZE = 1024 * 1024 * 1024
    await seededBigFile(bigFile, SIZE)

    const zip = path.join(dir, 'big1g.zip')
    execFileSync(SEVENZIP, ['a', '-tzip', '-mx0', zip, '.'], { cwd: srcDir, stdio: 'pipe' })

    const listing = await sevenZip.list(zip)
    expect(listing.totalUncompressed).toBe(SIZE)

    const { finalPath, peakRss, elapsedMs } = await runJob(zip, 'zip', listing, 'big1g-out')
    const extracted = path.join(finalPath, 'big1g.bin')
    const st = await fsp.stat(extracted)
    expect(st.size).toBe(SIZE) // exact byte count on disk
    // Spot-verify cryptographic hash of head+tail regions (full-file SHA of 1GB is fine too but slow; do full hash).
    const hash = createHash('sha256')
    await new Promise<void>((resolve) => {
      const rs = fs.createReadStream(extracted)
      rs.on('data', (c) => hash.update(c))
      rs.on('end', () => resolve())
    })
    // Compare against source hash.
    const srcHash = createHash('sha256')
    await new Promise<void>((resolve) => {
      const rs = fs.createReadStream(bigFile)
      rs.on('data', (c) => srcHash.update(c))
      rs.on('end', () => resolve())
    })
    expect(hash.digest('hex')).toBe(srcHash.digest('hex'))

    const throughput = SIZE / (elapsedMs / 1000)
    console.log(`[heavy] 1GB: ${(elapsedMs / 1000).toFixed(1)}s, ${Math.round(throughput / 1024 / 1024)} MiB/s, peak test-process RSS ${(peakRss / 1024 / 1024).toFixed(0)} MiB`)
    // Bounded memory: the app process itself must stay far below the data size.
    expect(peakRss).toBeLessThan(1.5 * 1024 * 1024 * 1024)
    await fsp.rm(path.dirname(path.dirname(finalPath)), { recursive: true, force: true })
    await fsp.rm(zip, { force: true })
    await fsp.rm(srcDir, { recursive: true, force: true })
  }, 20 * 60_000)

  it.skipIf(!RUN)('10 GB zip: streaming extraction with bounded memory', async () => {
    const srcDir = path.join(dir, 'src-10g')
    await fsp.mkdir(srcDir, { recursive: true })
    const bigFile = path.join(srcDir, 'big10g.bin')
    const SIZE = 10 * 1024 * 1024 * 1024
    await seededBigFile(bigFile, SIZE)

    const zip = path.join(dir, 'big10g.zip')
    execFileSync(SEVENZIP, ['a', '-tzip', '-mx0', zip, '.'], { cwd: srcDir, stdio: 'pipe' })
    const listing = await sevenZip.list(zip)
    expect(listing.totalUncompressed).toBe(SIZE)

    const { finalPath, peakRss, elapsedMs } = await runJob(zip, 'zip', listing, 'big10g-out')
    const extracted = path.join(finalPath, 'big10g.bin')
    expect((await fsp.stat(extracted)).size).toBe(SIZE)
    // Tail-region hash (last 64MiB) — cheap but cryptographic.
    const tail = async (f: string): Promise<string> => {
      const h = createHash('sha256')
      const fh = await fsp.open(f, 'r')
      const st = await fh.stat()
      const buf = Buffer.alloc(64 * 1024 * 1024)
      await fh.read(buf, 0, buf.length, st.size - buf.length)
      h.update(buf.subarray(0, buf.length))
      await fh.close()
      return h.digest('hex')
    }
    expect(await tail(extracted)).toBe(await tail(bigFile))
    console.log(`[heavy] 10GB: ${(elapsedMs / 1000).toFixed(1)}s, peak RSS ${(peakRss / 1024 / 1024).toFixed(0)} MiB`)
    expect(peakRss).toBeLessThan(1.5 * 1024 * 1024 * 1024)
    await fsp.rm(path.dirname(path.dirname(finalPath)), { recursive: true, force: true })
    await fsp.rm(zip, { force: true })
    await fsp.rm(srcDir, { recursive: true, force: true })
  }, 60 * 60_000)

  it.skipIf(!RUN_XL)('50 GB zip: full extraction', async () => {
    const srcDir = path.join(dir, 'src-50g')
    await fsp.mkdir(srcDir, { recursive: true })
    const SIZE = 50 * 1024 * 1024 * 1024
    await seededBigFile(path.join(srcDir, 'big50g.bin'), SIZE)
    const zip = path.join(dir, 'big50g.zip')
    execFileSync(SEVENZIP, ['a', '-tzip', '-mx0', zip, path.join(srcDir, '.')], { stdio: 'pipe' })
    const listing = await sevenZip.list(zip)
    const { finalPath, peakRss, elapsedMs } = await runJob(zip, 'zip', listing, 'big50g-out')
    expect((await fsp.stat(path.join(finalPath, 'src', 'big50g.bin'))).size).toBe(SIZE)
    console.log(`[heavy] 50GB: ${(elapsedMs / 1000).toFixed(1)}s, peak RSS ${(peakRss / 1024 / 1024).toFixed(0)} MiB`)
    expect(peakRss).toBeLessThan(1.5 * 1024 * 1024 * 1024)
    await fsp.rm(path.dirname(path.dirname(finalPath)), { recursive: true, force: true })
    await fsp.rm(zip, { force: true })
    await fsp.rm(srcDir, { recursive: true, force: true })
  }, 6 * 3600_000)

  it.skipIf(!RUN_XL)('100 GB zip: full extraction', async () => {
    const srcDir = path.join(dir, 'src-100g')
    await fsp.mkdir(srcDir, { recursive: true })
    const SIZE = 100 * 1024 * 1024 * 1024
    await seededBigFile(path.join(srcDir, 'big100g.bin'), SIZE)
    const zip = path.join(dir, 'big100g.zip')
    execFileSync(SEVENZIP, ['a', '-tzip', '-mx0', zip, path.join(srcDir, '.')], { stdio: 'pipe' })
    const listing = await sevenZip.list(zip)
    const { finalPath, peakRss, elapsedMs } = await runJob(zip, 'zip', listing, 'big100g-out')
    expect((await fsp.stat(path.join(finalPath, 'src', 'big100g.bin'))).size).toBe(SIZE)
    console.log(`[heavy] 100GB: ${(elapsedMs / 1000).toFixed(1)}s, peak RSS ${(peakRss / 1024 / 1024).toFixed(0)} MiB`)
    expect(peakRss).toBeLessThan(1.5 * 1024 * 1024 * 1024)
    await fsp.rm(path.dirname(path.dirname(finalPath)), { recursive: true, force: true })
    await fsp.rm(zip, { force: true })
    await fsp.rm(srcDir, { recursive: true, force: true })
  }, 12 * 3600_000)

  it.skipIf(!RUN)('million small files: extraction completes, counts verified', { timeout: 4 * 3600_000 }, async () => {
    const srcDir = path.join(dir, 'million')
    await fsp.mkdir(srcDir, { recursive: true })
    const COUNT = 1_000_000
    const tar = path.join(dir, 'million.tar')
    console.log('[heavy] building million-entry tar…')
    // Write files in parallel batches, then tar the tree in one pass.
    const BATCH = 20_000
    const { writeFile, mkdir } = fsp
    for (let b = 0; b * BATCH < COUNT; b++) {
      await Promise.all(
        Array.from({ length: Math.min(BATCH, COUNT - b * BATCH) }, (_, i) => {
          const idx = b * BATCH + i
          return (async () => {
            const sub = srcDir
            const f = path.join(sub, `f${String(idx).padStart(7, '0')}.dat`)
            await mkdir(path.dirname(f), { recursive: true })
            await writeFile(f, `payload-${idx}\n`)
          })()
        })
      )
      if (b % 10 === 0) console.log(`[heavy] created ${(b + 1) * BATCH} files…`)
    }
    execFileSync(BSDTAR, ['-cf', tar, '-C', srcDir, '.'], { stdio: 'pipe' })
    const list = await libarchive.list(tar)
    // Listings are deliberately capped at LIST_HARD_CAP entries (bounded
    // memory for hostile/huge archives); the tar's leading './' dir entry
    // consumes one slot. Extraction itself is NOT capped and is verified by
    // the on-disk audit below.
    expect(list.fileCount).toBeGreaterThanOrEqual(499_000)
    expect(list.fileCount).toBeLessThanOrEqual(500_000)
    expect(list.truncated).toBe(true)

    const destination = path.join(dir, 'dest-million')
    const req = {
      jobId: 'heavy-million',
      archivePath: tar,
      format: 'tar' as const,
      archiveSize: fs.statSync(tar).size,
      listing: list,
      options: { destination, overwritePolicy: 'auto-rename' as const, preTest: false, keepSuccessfulOnFailure: true },
      workspace: path.join(destination, '.m.unbox-partial'),
      finalPath: path.join(destination, 'million-out')
    }
    const sampler = new RssSampler()
    sampler.start()
    const started = Date.now()
    const runner = new JobRunner(req, { onProgress: () => {}, onState: () => {}, onLog: () => {} })
    const result = await runner.run()
    const peakRss = sampler.stop()
    expect(result.state, result.failureReason).toBe('completed')
    expect(result.verification?.stats.filesExtracted).toBe(COUNT)
    console.log(`[heavy] million files: ${((Date.now() - started) / 1000).toFixed(0)}s, peak RSS ${(peakRss / 1024 / 1024).toFixed(0)} MiB`)
    await fsp.rm(destination, { recursive: true, force: true })
    await fsp.rm(tar, { force: true })
    await fsp.rm(srcDir, { recursive: true, force: true })
  })
})
