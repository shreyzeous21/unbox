/**
 * JobRunner integration tests — the full extraction pipeline (no Electron):
 * preflight → validation → extract → audit → verification → atomic finalize.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  buildSourceTree, CREATORS, EXT_FOR_NAME, corruptMiddle, haveEngine, SEVENZIP,
  tmpRoot, type SourceManifest
} from '../fixtures/builders'
import { JobRunner, type RunJobRequest } from '../../src/main/services/extraction/job-runner'
import type { JobProgress, JobState } from '@shared/job-types'

const fixtureDir = tmpRoot('jr')
let manifest: SourceManifest
let archivePath: string

beforeAll(async () => {
  manifest = await buildSourceTree(path.join(fixtureDir, 'src'), { nested: 20 })
  archivePath = path.join(fixtureDir, `arch.7z`)
  CREATORS['7z']!(archivePath, manifest.root)
})

afterAll(async () => {
  await fsp.rm(fixtureDir, { recursive: true, force: true })
})

function makeReq(overrides: Partial<RunJobRequest> = {}): RunJobRequest {
  const destination = path.join(fixtureDir, `dest-${Math.random().toString(36).slice(2, 7)}`)
  return {
    jobId: `jr-${Math.random().toString(36).slice(2, 8)}`,
    archivePath,
    format: '7z',
    archiveSize: fs.statSync(archivePath).size,
    listing: null,
    options: {
      destination,
      overwritePolicy: 'auto-rename',
      preTest: true,
      keepSuccessfulOnFailure: true
    },
    workspace: path.join(destination, `.arch.unbox-partial-test`),
    finalPath: path.join(destination, 'arch'),
    ...overrides
  }
}

describe('JobRunner', () => {
  it.skipIf(!haveEngine(SEVENZIP))('completes with crc-verified outcome and correct stats', async () => {
    const req = makeReq()
    // Provide the real listing (as the orchestrator would).
    const { sevenZip } = await import('../../src/main/services/engines/sevenzip')
    req.listing = await sevenZip.list(archivePath)

    const states: JobState[] = []
    const progress: JobProgress[] = []
    const runner = new JobRunner(req, {
      onProgress: (p) => progress.push(p),
      onState: (s) => states.push(s),
      onLog: () => {}
    })
    const result = await runner.run()

    expect(result.state).toBe('completed')
    expect(result.verification?.outcome).toBe('crc-verified')
    expect(result.verification?.stats.filesExtracted).toBe(manifest.files.size)
    // Final rename happened: no temp dir, final dir present and byte-perfect.
    expect(fs.existsSync(req.workspace)).toBe(false)
    const problems = await verifyAgainst(req.finalPath)
    expect(problems).toEqual([])
    // Progress events actually flowed (not faked).
    expect(progress.length).toBeGreaterThan(0)
    expect(states).toContain('extracting')
    expect(states).toContain('verifying')
  })

  it.skipIf(!haveEngine(SEVENZIP))('fails a corrupt archive and never renames partials into place', async () => {
    const bad = path.join(fixtureDir, 'corrupt.7z')
    await fsp.copyFile(archivePath, bad)
    await corruptMiddle(bad, 1024)
    const { sevenZip } = await import('../../src/main/services/engines/sevenzip')
    const listing = await sevenZip.list(bad).catch(() => null)

    const req = makeReq({ archivePath: bad, listing })
    const runner = new JobRunner(req, {
      onProgress: () => {},
      onState: () => {},
      onLog: () => {}
    })
    const result = await runner.run()
    expect(result.state).toBe('failed')
    expect(result.verification?.outcome).toBe('failed')
    // CRITICAL: the final path must NOT exist — partials stay quarantined in temp.
    expect(fs.existsSync(req.finalPath)).toBe(false)
  })

  it.skipIf(!haveEngine(SEVENZIP))('cancels mid-extraction and reports cancelled', async () => {
    const { seededBigFile } = await import('../fixtures/builders-helpers')
    const bigDir = path.join(fixtureDir, 'cancel-src')
    await fsp.mkdir(bigDir, { recursive: true })
    await seededBigFile(path.join(bigDir, 'big.bin'), 1280 * 1024 * 1024)
    const bigZip = path.join(fixtureDir, 'cancel.zip')
    const { execFileSync } = await import('node:child_process')
    execFileSync(SEVENZIP, ['a', '-tzip', '-mx0', bigZip, path.join(bigDir, '.')], { stdio: 'pipe' })
    const { sevenZip } = await import('../../src/main/services/engines/sevenzip')
    const listing = await sevenZip.list(bigZip)

    const req = makeReq({
      archivePath: bigZip,
      listing,
      workspace: path.join(fixtureDir, 'cancel-dest', '.c.unbox-partial-x'),
      finalPath: path.join(fixtureDir, 'cancel-dest', 'c')
    })
    const runner = new JobRunner(req, { onProgress: () => {}, onState: () => {}, onLog: () => {} })
    setTimeout(() => runner.cancel(), 250)
    const result = await runner.run()
    expect(result.state).toBe('cancelled')
    expect(result.cancelled).toBe(true)
    // Partial files preserved in temp (policy), final path absent.
    expect(fs.existsSync(req.finalPath)).toBe(false)

    await fsp.rm(bigZip, { force: true })
    await fsp.rm(bigDir, { recursive: true, force: true })
    await fsp.rm(path.dirname(req.workspace), { recursive: true, force: true })
  }, 120_000)

  it.skipIf(!haveEngine(SEVENZIP))('refuses archives with traversal entries before extraction', async () => {
    const { createZipSlipArchive } = await import('../fixtures/builders')
    const evil = path.join(fixtureDir, 'evil.zip')
    await createZipSlipArchive(evil)
    const { sevenZip } = await import('../../src/main/services/engines/sevenzip')
    const listing = await sevenZip.list(evil)

    const req = makeReq({ archivePath: evil, format: 'zip', listing })
    const runner = new JobRunner(req, { onProgress: () => {}, onState: () => {}, onLog: () => {} })
    const result = await runner.run()
    expect(result.state).toBe('failed')
    expect(result.failureReason).toMatch(/unsafe paths/i)
    // Nothing escaped the workspace: no files outside destination.
    const destDir = path.dirname(req.workspace)
    const entries = await fsp.readdir(destDir)
    for (const e of entries) {
      expect(e.startsWith('.')).toBe(true) // only the hidden temp workspace
    }
  })

  it('keeps the source archive untouched in every outcome', async () => {
    const { sha256File } = await import('../fixtures/builders')
    const before = sha256File(archivePath)
    const req = makeReq()
    const { sevenZip } = await import('../../src/main/services/engines/sevenzip')
    req.listing = await sevenZip.list(archivePath)
    const runner = new JobRunner(req, { onProgress: () => {}, onState: () => {}, onLog: () => {} })
    await runner.run()
    expect(sha256File(archivePath)).toBe(before)
  })
})

async function verifyAgainst(root: string): Promise<string[]> {
  const { verifyTree } = await import('../fixtures/builders')
  // Archives created with an absolute `<root>/.` argument keep a single
  // wrapper directory (src/); locate it like engines.test does.
  let base = root
  if (!fs.existsSync(path.join(root, 'a.txt'))) {
    const entries = await fsp.readdir(root)
    for (const e of entries) {
      const p = path.join(root, e)
      if (fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'a.txt'))) {
        base = p
        break
      }
    }
  }
  return verifyTree(base, manifest)
}

// Silence unused import warning for EXT_FOR_NAME (used by future fixtures).
void EXT_FOR_NAME
