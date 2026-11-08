/**
 * Extraction orchestrator (main process) — owns the full job lifecycle:
 * detection → listing → validation → workspace setup → utilityProcess worker
 * → record persistence → recovery. The renderer only ever talks to this.
 */
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { utilityProcess, UtilityProcess, dialog, type BrowserWindow } from 'electron'
import type { FormatId } from '@shared/formats'
import { FORMAT_CAPABILITIES } from '@shared/formats'
import type { ExtractionStartRequest, JobEvent, JobRecord, JobState } from '@shared/job-types'
import { detectArchiveFormat } from '../archive-detect'
import { engineForFormat } from '../engines/registry'
import { validateListing, createTempWorkspace, uniqueDirectoryPath, removeTempWorkspace, SafeError } from '../fs-safety'
import type { ListResult } from '../engines/engine-types'
import { JobStore } from './job-store'
import type { HostToWorker, WorkerToHost } from './worker-protocol'
import type { Logger } from '../logging'

const RUNNING_STATES: JobState[] = ['queued', 'preflight', 'testing', 'listing', 'extracting', 'verifying', 'finalizing']

function newJobId(): string {
  // Timestamp + random: unique enough, filesystem-safe, sort-friendly.
  const t = Date.now().toString(36)
  const r = Math.random().toString(36).slice(2, 10)
  return `job-${t}-${r}`
}

function archiveBaseName(archivePath: string): string {
  const base = path.basename(archivePath)
  // Strip compound extensions first (.tar.gz → tar), then the outer one.
  const stripped = base.replace(/\.(tar\.(gz|bz2|xz|zst)|tgz|tbz2|txz|tzst|7z|zip|rar|iso|cab|wim|arj|lzh|lha|cpio|xar|msi|rpm|deb|dmg|gz|bz2|xz|zst|lzma|z)$/i, '')
  return stripped || base.replace(/\.[^.]+$/, '') || 'extracted'
}

export class ExtractionOrchestrator {
  private workers = new Map<string, UtilityProcess>()
  private passwords = new Map<string, string>() // jobId → password, memory-only
  private activeJobs = new Map<string, JobRecord>()
  private queue: Array<{ req: ExtractionStartRequest; resolve: (r: JobRecord) => void; reject: (e: Error) => void }> = []
  private concurrency: number

  constructor(
    private store: JobStore,
    private logger: Logger,
    private sendEvent: (event: JobEvent) => void,
    private getWindow: () => BrowserWindow | null,
    concurrency = 1
  ) {
    this.concurrency = Math.max(1, Math.min(4, concurrency))
  }

  setConcurrency(n: number): void {
    this.concurrency = Math.max(1, Math.min(4, n))
    this.pumpQueue()
  }

  // ------------------------------------------------------------------
  // Startup recovery
  // ------------------------------------------------------------------

  /** Called once at app start: reconcile persisted records against disk truth. */
  async recoverAtStartup(): Promise<string[]> {
    const recovered: string[] = []
    const records = await this.store.all()
    for (const record of records) {
      if (!RUNNING_STATES.includes(record.state)) continue
      // The process died mid-job. The temp workspace tells the truth:
      // present ⇒ partially extracted files exist; absent ⇒ nothing happened.
      let tempExists = false
      if (record.tempPath) {
        tempExists = await fsp
          .stat(record.tempPath)
          .then(() => true)
          .catch(() => false)
      }
      record.state = 'interrupted'
      record.outcome = 'interrupted'
      record.failureReason = tempExists
        ? 'application was closed or crashed during extraction; partial files kept in the temporary folder'
        : 'application was closed or crashed during extraction; no partial files remain'
      record.updatedAt = Date.now()
      await this.store.save(record)
      recovered.push(record.id)
      this.logger.warn('orchestrator', 'recovered interrupted job at startup', { jobId: record.id, tempExists })
    }
    return recovered
  }

  // ------------------------------------------------------------------
  // Job control
  // ------------------------------------------------------------------

  async startJob(req: ExtractionStartRequest): Promise<JobRecord> {
    return new Promise((resolve, reject) => {
      this.queue.push({ req, resolve, reject })
      this.pumpQueue()
    })
  }

  private pumping = false
  private async pumpQueue(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.activeJobs.size < this.concurrency && this.queue.length > 0) {
        const next = this.queue.shift()
        if (!next) break
        void this.launch(next.req)
          .then(next.resolve)
          .catch(next.reject)
        // launch() resolves when the job RECORD is created (not when done);
        // activeJobs drives the concurrency bound.
        await new Promise((r) => setTimeout(r, 0))
      }
    } finally {
      this.pumping = false
    }
  }

  private async launch(req: ExtractionStartRequest): Promise<JobRecord> {
    const jobId = newJobId()
    const now = Date.now()

    // --- archive stat + detection ---
    let archiveSize: number
    try {
      archiveSize = (await fsp.stat(req.archivePath)).size
    } catch (err) {
      throw new SafeError('ARCHIVE_UNREADABLE', `cannot read archive: ${(err as Error).message}`)
    }
    const detection = await detectArchiveFormat(req.archivePath, archiveSize)
    if (detection.format === 'unknown') {
      throw new SafeError('UNKNOWN_FORMAT', 'file is not a recognizable archive')
    }
    const format = detection.format as FormatId
    const caps = FORMAT_CAPABILITIES[format]
    if (!caps) throw new SafeError('UNKNOWN_FORMAT', `unsupported format: ${format}`)

    // --- cheap listing where the format allows ---
    let listing: ListResult | null = null
    if (caps.canList === 'cheap') {
      const engine = await engineForFormat(format)
      if (engine) {
        try {
          listing = await engine.list(req.archivePath, { password: req.password })
          const violations = validateListing(listing.entries.map((e) => e.name))
          if (violations.length > 0) {
            throw new SafeError(
              'UNSAFE_ARCHIVE_PATHS',
              `${violations.length} archive entries contain unsafe paths (traversal/absolute) — extraction refused. First: ${violations[0]?.detail ?? ''}`
            )
          }
        } catch (err) {
          if (err instanceof SafeError) throw err
          // Listing failure is not necessarily fatal (e.g. header-encrypted 7z
          // needs a password for listing) — let the worker surface a precise error.
          this.logger.warn('orchestrator', 'cheap listing failed; continuing without listing', {
            jobId,
            error: (err as Error).message
          })
          listing = null
        }
      }
    }

    // --- destination + workspace + final path ---
    const dest = req.options.destination
    const folderName = req.options.folderName?.trim() || archiveBaseName(req.archivePath)
    const finalPath = await uniqueDirectoryPath(path.join(dest, folderName))
    const workspace = await createTempWorkspace(dest, jobId, path.basename(finalPath))

    // --- conflict handling per policy ---
    if (finalPath !== path.join(dest, folderName) && req.options.overwritePolicy === 'ask') {
      const win = this.getWindow()
      if (win) {
        const r = await dialog.showMessageBox(win, {
          type: 'question',
          message: `“${folderName}” already exists in this location.`,
          detail: `Unbox will extract into “${path.basename(finalPath)}” instead. Existing files are never modified.`,
          buttons: ['Extract to new folder', 'Cancel'],
          defaultId: 0,
          cancelId: 1
        })
        if (r.response !== 0) {
          await removeTempWorkspace(workspace)
          throw new SafeError('CANCELLED', 'cancelled at destination conflict prompt')
        }
      }
    }

    const record: JobRecord = {
      id: jobId,
      createdAt: now,
      updatedAt: now,
      state: 'queued',
      archivePath: req.archivePath,
      archiveSize,
      format,
      options: req.options,
      plannedPath: finalPath,
      tempPath: workspace,
      progress: {
        state: 'queued',
        filesDone: 0,
        bytesDone: 0,
        elapsedMs: 0,
        totalsKnown: listing?.totalUncompressed !== undefined && !caps.sizeUnknownUpfront,
        ...(listing?.totalUncompressed !== undefined ? { bytesTotal: listing.totalUncompressed } : {}),
        ...(listing ? { filesTotal: listing.fileCount } : {})
      },
      issues: [],
      appVersion: process.env.npm_package_version ?? '0.1.0'
    }
    if (req.password !== undefined) this.passwords.set(jobId, req.password)
    await this.store.save(record)
    this.activeJobs.set(jobId, record)
    this.sendEvent({ type: 'state', jobId, state: 'queued' })
    this.spawnWorker(record, listing, req.password)
    return record
  }

  // ------------------------------------------------------------------
  // Worker plumbing
  // ------------------------------------------------------------------

  /**
   * Locates the compiled extraction-worker entry. The orchestrator is bundled
   * into a shared chunk, where build-time `__dirname` points at chunks/ —
   * probe the plausible output layouts instead of trusting it.
   */
  private workerEntryPath(): string {
    const candidates = [
      path.join(__dirname, 'extraction-worker.js'),
      path.join(__dirname, '..', 'extraction-worker.js'),
      path.join(process.cwd(), 'out/main/extraction-worker.js')
    ]
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c
      } catch {
        /* keep probing */
      }
    }
    return candidates[0] as string
  }

  private spawnWorker(record: JobRecord, listing: ListResult | null, password?: string): void {
    const workerPath = this.workerEntryPath()
    const child = utilityProcess.fork(workerPath, [`--job=${record.id}`], {
      serviceName: `unbox-extract-${record.id}`,
      // Piped so worker bootstrap failures land in our logs — an 'ignore'd
      // crash is undiagnosable in the field.
      stdio: ['ignore', 'ignore', 'pipe']
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line.trim()) this.logger.error('worker-stderr', line, { jobId: record.id })
      }
    })
    this.workers.set(record.id, child)

    const req: HostToWorker = {
      type: 'start',
      req: {
        jobId: record.id,
        archivePath: record.archivePath,
        format: record.format === 'unknown' ? 'zip' : record.format,
        archiveSize: record.archiveSize,
        listing,
        password,
        options: record.options,
        workspace: record.tempPath ?? '',
        finalPath: record.plannedPath ?? path.join(record.options.destination, path.basename(record.tempPath ?? '').replace(/^\.|\.unbox-partial-.*$/g, ''))
      }
    }

    // NOTE: UtilityProcess 'message' delivers the payload DIRECTLY (unlike
    // the worker-side parentPort, which wraps it in a MessageEvent).
    const onMessage = (msg: WorkerToHost): void => {
      void this.handleWorkerMessage(record.id, msg)
    }
    child.on('message', onMessage)
    child.on('exit', (code) => {
      this.workers.delete(record.id)
      // If we never got a result message, the worker died hard.
      const current = this.activeJobs.get(record.id)
      if (current && RUNNING_STATES.includes(current.state)) {
        void this.finishJob(record.id, {
          state: 'interrupted',
          cancelled: false,
          failureReason: `extraction worker exited unexpectedly (code ${code ?? 'signal'}) — partial files kept`,
          verification: null,
          engine: null,
          elapsedMs: 0
        })
      }
    })

    child.postMessage(req)
    this.logger.info('orchestrator', 'worker spawned', { jobId: record.id, format: record.format })
  }

  private async handleWorkerMessage(jobId: string, msg: WorkerToHost): Promise<void> {
    const record = this.activeJobs.get(jobId)
    if (!record) return
    switch (msg.type) {
      case 'progress': {
        record.progress = msg.progress
        record.updatedAt = Date.now()
        this.sendEvent({ type: 'progress', jobId, progress: msg.progress })
        // Throttled persistence: full record save at most every 2s.
        if (Date.now() - record.updatedAt > 2000) {
          record.updatedAt = Date.now()
          await this.store.save(record).catch(() => {})
        }
        break
      }
      case 'state': {
        record.state = msg.state
        // Clear stale phase text when the engine moves on without a detail.
        record.progress.phaseDetail = msg.detail
        record.updatedAt = Date.now()
        await this.store.save(record).catch(() => {})
        this.sendEvent({ type: 'state', jobId, state: msg.state, detail: msg.detail })
        break
      }
      case 'log': {
        this.logger.debug('worker', msg.line, { jobId })
        break
      }
      case 'result': {
        await this.finishJob(jobId, msg.result)
        break
      }
      case 'fatal': {
        this.logger.error('orchestrator', 'worker fatal', { jobId, error: msg.error })
        await this.finishJob(jobId, {
          state: 'failed',
          cancelled: false,
          failureReason: msg.error.split('\n')[0] ?? 'worker crashed',
          verification: null,
          engine: null,
          elapsedMs: 0
        })
        break
      }
    }
  }

  private finishing = new Set<string>()
  private async finishJob(jobId: string, result: Awaited<ReturnType<import('./job-runner').JobRunner['run']>>): Promise<void> {
    if (this.finishing.has(jobId)) return
    this.finishing.add(jobId)
    try {
      const record = this.activeJobs.get(jobId)
      const child = this.workers.get(jobId)
      if (child) {
        child.kill()
        this.workers.delete(jobId)
      }
      const password = this.passwords.get(jobId)
      if (password !== undefined) {
        // Zero the string reference immediately.
        this.passwords.delete(jobId)
      }
      if (!record) return

      const caps = FORMAT_CAPABILITIES[record.format as FormatId]
      record.state = result.state
      record.outcome =
        result.state === 'completed'
          ? 'ok'
          : result.state === 'completed-with-warnings'
            ? 'ok-with-warnings'
            : result.state === 'cancelled'
              ? 'cancelled'
              : result.state === 'interrupted'
                ? 'interrupted'
                : 'failed'
      record.failureReason = result.failureReason
      record.engine = result.engine ?? undefined
      record.updatedAt = Date.now()
      record.verification = result.verification
        ? {
            requested: record.options.preTest,
            outcome: result.verification.outcome,
            integrity: caps?.integrity ?? 'none',
            ...(result.state === 'completed' || result.state === 'completed-with-warnings'
              ? { preTestPassed: record.options.preTest && (caps?.canPreTest ?? false) }
              : {})
          }
        : undefined
      record.stats = result.verification?.stats
      record.issues = result.verification?.issues ?? record.issues
      if (result.state === 'completed' || result.state === 'completed-with-warnings') {
        record.outputPath = record.plannedPath
        record.tempPath = undefined
      }
      await this.store.save(record)
      this.activeJobs.delete(jobId)
      this.sendEvent({ type: 'completed', jobId, outcome: record.outcome ?? 'failed', record })
      this.logger.info('orchestrator', 'job finished', { jobId, state: result.state })
      this.pumpQueue()
    } finally {
      this.finishing.delete(jobId)
    }
  }

  async cancelJob(jobId: string): Promise<boolean> {
    const child = this.workers.get(jobId)
    if (!child) return false
    const msg: HostToWorker = { type: 'cancel' }
    child.postMessage(msg)
    // Hard-kill fallback: if the engine ignores the abort for 10s, kill it.
    setTimeout(() => {
      const still = this.workers.get(jobId)
      if (still) {
        still.kill()
        this.logger.warn('orchestrator', 'worker hard-killed after cancel timeout', { jobId })
      }
    }, 10_000).unref?.()
    return true
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    return this.activeJobs.get(jobId) ?? (await this.store.load(jobId))
  }

  async listJobs(): Promise<JobRecord[]> {
    const all = await this.store.all()
    // Overlay live records.
    for (const [id, rec] of this.activeJobs) {
      const i = all.findIndex((r) => r.id === id)
      if (i >= 0) all[i] = rec
      else all.unshift(rec)
    }
    return all
  }

  async cleanupJob(jobId: string, mode: 'remove-temp' | 'forget'): Promise<JobRecord | null> {
    const record = (await this.getJob(jobId)) as JobRecord | null
    if (!record) return null
    if (mode === 'remove-temp' && record.tempPath) {
      const ok = await removeTempWorkspace(record.tempPath)
      if (!ok) {
        this.logger.warn('orchestrator', 'temp cleanup failed', { jobId, tempPath: record.tempPath })
      } else {
        record.tempPath = undefined
      }
    }
    if (mode === 'forget') {
      await this.store.delete(jobId)
      return null
    }
    record.updatedAt = Date.now()
    await this.store.save(record)
    return record
  }

  async openInFinder(jobId: string, partial: boolean): Promise<void> {
    const record = await this.getJob(jobId)
    if (!record) return
    const target = partial ? record.tempPath : record.outputPath
    if (!target) return
    const { shell } = await import('electron')
    await shell.openPath(target)
  }
}
