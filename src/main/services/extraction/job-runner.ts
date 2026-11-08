/**
 * Job runner — executes ONE extraction job end-to-end. Deliberately free of
 * Electron imports so the utilityProcess worker and the integration test
 * suite drive the exact same code path.
 *
 * Pipeline: preflight → (optional) engine pre-test → extract → tree audit +
 * entry verification → finalize (fsync + atomic rename).
 *
 * Failure policy: any fatal issue ⇒ the job is failed, successful files are
 * preserved in the temp workspace and (when keepSuccessfulOnFailure) renamed
 * into place; the source archive is NEVER touched.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { FORMAT_CAPABILITIES, type FormatId } from '@shared/formats'
import type { JobIssue, JobOptions, JobProgress, JobState } from '@shared/job-types'
import type { Engine, ListResult, EngineIssue } from '../engines/engine-types'
import { engineForFormat } from '../engines/registry'
import { auditExtractedTree, fsyncDir, SafeError } from '../fs-safety'
import { hasEnoughSpaceFor, preflightDiskSpace, volumeFor } from '../disk-space'
import { verifyExtraction, type VerificationReport } from '../verification'

export interface RunJobRequest {
  jobId: string
  archivePath: string
  format: FormatId
  archiveSize: number
  /** Pre-computed cheap listing (main process does this before spawning the worker). */
  listing: ListResult | null
  password?: string
  options: JobOptions
  /** Pre-created hidden temp workspace (inside destination volume). */
  workspace: string
  /** Pre-computed unique final output directory. */
  finalPath: string
}

export interface RunJobCallbacks {
  onProgress(progress: JobProgress): void
  onState(state: JobState, detail?: string): void
  /** Unbounded structured log stream (worker forwards to main's logger). */
  onLog(line: string): void
}

export interface RunJobResult {
  state: JobState
  cancelled: boolean
  failureReason?: string
  verification: VerificationReport | null
  engine: { id: string; version: string } | null
  /** Total wall time in ms. */
  elapsedMs: number
}

const PROGRESS_THROTTLE_MS = 100
const SPACE_CHECK_INTERVAL_MS = 4_000

export class JobRunner {
  private progress: JobProgress
  private lastEmit = 0
  private aborted = false
  private controller = new AbortController()
  private startedAt: number | undefined
  private sizeIndexCache: Map<string, number> | null | undefined

  constructor(
    private req: RunJobRequest,
    private cb: RunJobCallbacks
  ) {
    this.progress = {
      state: 'queued',
      filesDone: 0,
      bytesDone: 0,
      elapsedMs: 0,
      totalsKnown: false
    }
  }

  cancel(): void {
    this.aborted = true
    this.controller.abort()
  }

  async run(): Promise<RunJobResult> {
    const startedAt = Date.now()
    this.markStarted()
    const { req, cb } = this
    const caps = FORMAT_CAPABILITIES[req.format]
    let issues: JobIssue[] = []
    let engine: Engine | null = null
    let engineVersion: string | null = null
    let verification: VerificationReport | null = null

    const setState = (state: JobState, detail?: string): void => {
      this.progress = { ...this.progress, state, ...(detail !== undefined ? { phaseDetail: detail } : {}) }
      cb.onState(state, detail)
      this.emit(true)
    }

    try {
      // ---------- 0. engine resolution ----------
      engine = await engineForFormat(req.format)
      if (!engine) {
        throw new SafeError('NO_ENGINE', `no available engine can extract ${req.format} archives (vendored engine missing?)`)
      }
      engineVersion = await engine.version()

      // ---------- 1. preflight ----------
      setState('preflight', 'checking disk space')
      // Destination must exist for statfs; worker may run standalone.
      await fsp.mkdir(req.options.destination, { recursive: true })
      const knownTotal = req.listing?.totalUncompressed
      const fileCount = req.listing?.fileCount ?? 0
      const pf = await preflightDiskSpace(path.dirname(req.finalPath), knownTotal, req.archiveSize, fileCount)
      if (!pf.ok && pf.estimateKnown) {
        throw new SafeError('DISK_FULL_PREFLIGHT', pf.message ?? 'not enough disk space')
      }
      if (!pf.ok) {
        // Stream formats: warn loudly but proceed; live checks below will stop it.
        cb.onLog(`[preflight] ${pf.message}`)
        issues.push({ severity: 'warning', code: 'SPACE_ESTIMATE_ROUGH', message: pf.message ?? '' })
      }
      // Destination volume reachable?
      const vol = await volumeFor(req.options.destination)
      if (!vol) throw new SafeError('DESTINATION_UNREACHABLE', `destination volume is not accessible`)

      // ---------- 2. entry-name validation (listing available) ----------
      if (req.listing && caps.canList === 'cheap') {
        setState('preflight', 'validating entry paths')
        const { validateListing } = await import('../fs-safety')
        const violations = validateListing(req.listing.entries.map((e) => e.name))
        if (violations.length > 0) {
          for (const v of violations.slice(0, 50)) {
            issues.push({ severity: 'error', code: `UNSAFE_PATH_${v.violation?.toUpperCase()}`, message: v.detail ?? 'unsafe archive entry path' })
          }
          throw new SafeError('UNSAFE_ARCHIVE_PATHS', `${violations.length} archive entrie(s) contain unsafe paths (traversal/absolute); extraction refused`)
        }
      }

      // ---------- 3. pre-test ----------
      let preTestPassed = false
      if (req.options.preTest && caps.canPreTest && engine.test) {
        setState('testing', `testing archive integrity (${engine.id})`)
        const t = await engine.test(req.archivePath, {
          password: req.password,
          signal: this.controller.signal,
          callbacks: { onLog: (l) => cb.onLog(l) }
        })
        if (t.cancelled) throw new SafeError('CANCELLED', 'cancelled during integrity test')
        if (!t.ok) {
          issues.push(...t.issues.map((i: EngineIssue) => ({ severity: i.severity, code: i.code, message: i.message })))
          throw new SafeError('PRE_TEST_FAILED', 'archive failed the integrity test before extraction began')
        }
        issues.push(...t.issues.map((i: EngineIssue) => ({ severity: i.severity, code: i.code, message: i.message })))
        preTestPassed = true
      } else if (req.options.preTest && !caps.canPreTest) {
        cb.onLog(`[test] format ${req.format} does not support a full pre-test; integrity is checked during extraction`)
      }

      // ---------- 4. extraction ----------
      setState('extracting')
      const totalsKnown = req.listing?.totalUncompressed !== undefined && caps.sizeUnknownUpfront === false
      this.progress = { ...this.progress, totalsKnown, bytesTotal: req.listing?.totalUncompressed, filesTotal: req.listing?.fileCount }

      // Live free-space watchdog for stream formats and huge known sizes.
      let spaceTimer: NodeJS.Timeout | null = null
      let lastSpaceCheck = { consumed: 0, produced: 0 }
      if (!totalsKnown || (knownTotal ?? 0) > pf.freeBytes * 0.5) {
        spaceTimer = setInterval(() => {
          void (async () => {
            const ok = await hasEnoughSpaceFor(
              req.options.destination,
              lastSpaceCheck.consumed,
              req.archiveSize,
              lastSpaceCheck.produced
            )
            if (!ok && !this.aborted) {
              cb.onLog('[space] free space dropped below the projected requirement — aborting to protect data')
              this.cancel()
            }
          })()
        }, SPACE_CHECK_INTERVAL_MS)
        spaceTimer.unref?.()
      }

      let extractResult
      try {
        extractResult = await engine.extract(req.archivePath, {
          outDir: req.workspace,
          password: req.password,
          signal: this.controller.signal,
          stallTimeoutMs: 180_000,
          callbacks: {
            onProgress: (p) => {
              // Blend engine progress with listing sizes when both exist.
              const sizeByName = this.sizeIndex(req.listing)
              let bytesDone = this.progress.bytesDone
              if (p.fileDone !== undefined && sizeByName) {
                const s = sizeByName.get(p.fileDone)
                if (s !== undefined) bytesDone += s
              }
              if (p.enginePercent !== undefined && totalsKnown) {
                // Prefer direct percent → bytes; keep fileDone sums as lower bound.
                const byPercent = Math.floor(((req.listing?.totalUncompressed ?? 0) * p.enginePercent) / 100)
                bytesDone = Math.max(bytesDone, byPercent)
              }
              this.progress = {
                ...this.progress,
                bytesDone,
                filesDone: p.filesDone ?? this.progress.filesDone,
                currentFile: p.currentFile ?? this.progress.currentFile
              }
              this.emit()
            },
            onLog: (l) => {
              cb.onLog(l)
              // Track consumption for the space watchdog on stream formats.
              const m = /\[(?:zstd)\]\s*[\d.]+ ?(?:MiB|GiB|KiB)/.exec(l)
              if (m) {
                lastSpaceCheck = { consumed: this.progress.bytesDone, produced: this.progress.bytesDone }
              }
            }
          }
        })
      } finally {
        if (spaceTimer) clearInterval(spaceTimer)
      }

      if (this.aborted) {
        throw new SafeError('CANCELLED', 'extraction cancelled')
      }

      // Engine failure with no recognizable issue lines:
      if (!extractResult.ok && extractResult.issues.length === 0) {
        issues.push({
          severity: 'error',
          code: 'ENGINE_FAILED',
          message: `engine ${engine.id} exited with code ${extractResult.exitCode ?? 'signal'} without a diagnosable error`
        })
      } else {
        issues.push(...extractResult.issues.map((i) => ({ severity: i.severity, code: i.code, message: i.message })))
      }

      // ---------- 5. audit + verify ----------
      setState('verifying', 'auditing extracted files')
      const audit = await auditExtractedTree(req.workspace, (n) => {
        this.progress = { ...this.progress, phaseDetail: `auditing (${n} entries visited)` }
        this.emit(true)
      })
      this.progress = { ...this.progress, filesDone: audit.files, bytesDone: audit.bytes }
      this.emit(true)

      verification = await verifyExtraction({
        format: req.format,
        list: req.listing,
        extract: extractResult,
        preTestPassed,
        root: req.workspace,
        audit,
        sizeUnknownUpfront: caps.sizeUnknownUpfront
      })
      issues = verification.issues

      const hasFatal =
        verification.outcome === 'failed' ||
        issues.some((i) => i.severity === 'error')

      if (hasFatal && !req.options.keepSuccessfulOnFailure) {
        throw new SafeError('EXTRACTION_FAILED', this.firstErrorMessage(issues) ?? 'extraction failed verification')
      }

      // ---------- 6. finalize ----------
      if (hasFatal) {
        // keepSuccessfulOnFailure: promote the verified-good tree, report errors.
        cb.onLog('[finalize] keeping successfully extracted files; errors recorded in report')
      }
      setState('finalizing', 'moving files into place')
      // fsync the workspace dir so entries are durable before rename.
      await fsyncDir(req.workspace).catch(() => {
        cb.onLog('[finalize] warning: could not fsync workspace directory')
      })
      await fsp.rename(req.workspace, req.finalPath)
      await fsyncDir(path.dirname(req.finalPath)).catch(() => {})

      const failed = verification?.outcome === 'failed' || issues.some((i) => i.severity === 'error')
      const finalState: JobState = failed ? 'completed-with-warnings' : 'completed'
      setState(finalState)
      if (verification) {
        // Reflect authoritative disk numbers in the final progress snapshot.
        this.progress = {
          ...this.progress,
          state: finalState,
          filesDone: verification.stats.filesExtracted,
          filesTotal: verification.stats.filesExtracted,
          bytesDone: verification.stats.bytesExtracted,
          bytesTotal: totalsKnown ? req.listing?.totalUncompressed : verification.stats.bytesExtracted,
          totalsKnown: true
        }
        this.emit(true)
      }

      return {
        state: finalState,
        cancelled: false,
        verification,
        engine: { id: engine.id, version: engineVersion ?? '' },
        elapsedMs: Date.now() - startedAt
      }
    } catch (err) {
      const isCancel = this.aborted || (err instanceof SafeError && err.code === 'CANCELLED')
      const reason = err instanceof Error ? err.message : String(err)
      const code = err instanceof SafeError ? err.code : 'UNEXPECTED'
      cb.onLog(`[job] failed: ${code}: ${reason}`)
      if (isCancel) {
        setState('cancelled')
        return {
          state: 'cancelled',
          cancelled: true,
          failureReason: 'cancelled by user',
          verification,
          engine: engine ? { id: engine.id, version: engineVersion ?? '' } : null,
          elapsedMs: Date.now() - startedAt
        }
      }
      setState('failed', reason)
      if (issues.length === 0 || err instanceof SafeError) {
        issues.push({ severity: 'error', code, message: reason })
      }
      if (verification) {
        verification.issues = issues
        verification.outcome = 'failed'
      }
      return {
        state: 'failed',
        cancelled: false,
        failureReason: reason,
        verification: verification ?? {
          outcome: 'failed',
          issues,
          stats: { filesExtracted: 0, filesFailed: 0, foldersCreated: 0, linksCreated: 0, bytesExtracted: 0 }
        },
        engine: engine ? { id: engine.id, version: engineVersion ?? '' } : null,
        elapsedMs: Date.now() - startedAt
      }
    }
  }

  /** Bounded name→size map for byte accounting; null when listing too big. */
  private sizeIndex(list: ListResult | null): Map<string, number> | null {
    if (this.sizeIndexCache !== undefined) return this.sizeIndexCache
    if (!list || list.entries.length > 200_000) {
      this.sizeIndexCache = null
      return null
    }
    const m = new Map<string, number>()
    for (const e of list.entries) {
      if (!e.isDir && e.size !== undefined) m.set(e.name, e.size)
    }
    this.sizeIndexCache = m
    return m
  }

  private firstErrorMessage(issues: JobIssue[]): string | undefined {
    return issues.find((i) => i.severity === 'error')?.message
  }

  /** Throttled progress emit (true = force). */
  private emit(force = false): void {
    const now = Date.now()
    if (!force && now - this.lastEmit < PROGRESS_THROTTLE_MS) return
    this.lastEmit = now
    const elapsed = now - (this.startedAt ?? now)
    const bytesDone = this.progress.bytesDone
    const bytesTotal = this.progress.bytesTotal
    const bytesPerSecond = elapsed > 500 ? Math.round((bytesDone / elapsed) * 1000) : undefined
    const etaMs =
      bytesTotal && bytesTotal > bytesDone && bytesPerSecond && bytesPerSecond > 0
        ? Math.round(((bytesTotal - bytesDone) / bytesPerSecond) * 1000)
        : undefined
    this.cb.onProgress({ ...this.progress, elapsedMs: elapsed, bytesPerSecond, etaMs })
  }

  markStarted(): void {
    this.startedAt ??= Date.now()
  }
}
