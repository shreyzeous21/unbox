/**
 * Typed IPC layer. Every handler validates its input (paths must be
 * absolute, non-empty, and inside the user's readable universe) before any
 * privileged work. The renderer has no other surface.
 */
import { dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import {
  IPC,
  type ArchiveInspectResponse,
  type DiagnosticsResponse,
  type JobCleanupRequest
} from '@shared/ipc-contracts'
import type { JobRecord } from '@shared/job-types'
import { detectArchiveFormat } from './services/archive-detect'
import { engineAvailability, engineForFormat } from './services/engines/registry'
import { FORMAT_CAPABILITIES, formatLabel, type FormatId } from '@shared/formats'
import { volumeFor } from './services/disk-space'
import { ExtractionOrchestrator } from './services/extraction/orchestrator'
import type { Settings } from './services/settings'
import type { Logger } from './services/logging'
import path from 'node:path'
import { app } from 'electron'

function assertAbsolutePath(p: unknown, label: string): string {
  if (typeof p !== 'string' || p.length === 0 || !path.isAbsolute(p)) {
    throw new Error(`${label} must be an absolute path`)
  }
  // Refuse null bytes / control chars outright.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) throw new Error(`${label} contains control characters`)
  return p
}

export interface IpcDeps {
  orchestrator: ExtractionOrchestrator
  settings: Settings
  logger: Logger
  getWindow: () => BrowserWindow | null
}

function formatCapabilities(id: FormatId | 'unknown'): string[] {
  if (id === 'unknown') return []
  const caps = FORMAT_CAPABILITIES[id]
  if (!caps) return []
  const notes: string[] = []
  notes.push(`Verification level: ${caps.integrity === 'entry-crc' ? 'per-entry CRC verified during extraction' : caps.integrity === 'codec' ? 'compression-stream checksums only' : caps.integrity === 'header' ? 'weak header checksums only' : 'no integrity information in this format'}`)
  if (caps.canPreTest) notes.push('Full integrity pre-test supported.')
  if (caps.sizeUnknownUpfront) notes.push('Uncompressed total size is unknown before extraction (stream format).')
  if (caps.notes) notes.push(caps.notes)
  return notes
}

export function registerIpc(deps: IpcDeps): void {
  const { orchestrator, settings, logger } = deps

  ipcMain.handle(IPC.ArchiveOpen, async () => {
    const win = deps.getWindow()
    const res = await dialog.showOpenDialog(win!, {
      title: 'Choose archives to extract',
      properties: ['openFile', 'multiSelections'],
      // Broad but not misleading: engines decide what they can actually open.
      filters: [{ name: 'Archives', extensions: ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'tbz2', 'xz', 'txz', 'zst', 'tzst', 'lzma', 'z', 'iso', 'cab', 'wim', 'swm', 'arj', 'lzh', 'lha', 'cpio', 'xar', 'pkg', 'msi', 'rpm', 'deb', 'dmg'] }]
    })
    return res.canceled ? [] : res.filePaths
  })

  ipcMain.handle(IPC.ArchiveInspect, async (_e, raw: unknown): Promise<ArchiveInspectResponse> => {
    const p = assertAbsolutePath((raw as { path?: string })?.path, 'path')
    const { statSync } = await import('node:fs')
    const st = statSync(p)
    const detection = await detectArchiveFormat(p, st.size)
    const errors: string[] = []
    const missingVolumes: string[] = []
    let multiVolumeHint = false
    let encryptedHint = false
    let listing: ArchiveInspectResponse['listing'] | undefined

    if (detection.format !== 'unknown') {
      const caps = FORMAT_CAPABILITIES[detection.format as FormatId]
      // Multi-volume hints: adjacent volumes for split archives.
      const name = path.basename(p)
      if (/\.(zip|7z)\.001$/i.test(name)) multiVolumeHint = true
      if (/\.(zip|7z)\.001$/i.test(name)) {
        const stem = name.replace(/\.001$/, '')
        for (let i = 2; i < 1000; i++) {
          const vol = path.join(path.dirname(p), `${stem}.${String(i).padStart(3, '0')}`)
          try {
            await import('node:fs').then((fs) => fs.statSync(vol))
          } catch {
            if (i === 2) errors.push(`multi-volume archive is missing its second part: ${path.basename(vol)}`)
            else missingVolumes.push(vol)
            break
          }
        }
      }
      if (/\.z01$/i.test(name) || /\.part\d+\.rar$/i.test(name)) multiVolumeHint = true

      const engine = await engineForFormat(detection.format as FormatId)
      if (engine && caps.canList === 'cheap') {
        try {
          const list = await engine.list(p)
          encryptedHint = list.encrypted
          listing = {
            fileCount: list.fileCount,
            folderCount: list.folderCount,
            totalUncompressed: list.totalUncompressed,
            encrypted: list.encrypted,
            sampleEntries: list.entries.slice(0, 50).map((e) => ({ name: e.name, size: e.size, isDir: e.isDir })),
            truncated: list.truncated
          }
        } catch (err) {
          const msg = (err as Error).message
          if (/wrong password|encrypted/i.test(msg)) {
            encryptedHint = true
            errors.push('archive appears to be encrypted — a password is required')
          } else {
            errors.push(`listing failed: ${msg}`)
          }
        }
      }
      if (engine === null) {
        errors.push(`no extraction engine available for ${formatLabel(detection.format as FormatId)} (engine not vendored?)`)
      }
    }

    return {
      path: p,
      size: st.size,
      format: detection.format,
      confidence: detection.confidence,
      humanSize: humanSize(st.size),
      encryptedHint,
      multiVolumeHint,
      missingVolumes,
      capabilityNotes: formatCapabilities(detection.format),
      listing,
      errors
    }
  })

  ipcMain.handle(IPC.ArchiveList, async (_e, raw: unknown) => {
    const p = assertAbsolutePath((raw as { path?: string })?.path, 'path')
    const detection = await detectArchiveFormat(p)
    if (detection.format === 'unknown') return null
    const engine = await engineForFormat(detection.format as FormatId)
    if (!engine) return null
    const caps = FORMAT_CAPABILITIES[detection.format as FormatId]
    if (caps.canList === 'no') return null
    const list = await engine.list(p)
    return {
      fileCount: list.fileCount,
      folderCount: list.folderCount,
      totalUncompressed: list.totalUncompressed,
      encrypted: list.encrypted,
      sampleEntries: list.entries.slice(0, 50).map((e) => ({ name: e.name, size: e.size, isDir: e.isDir })),
      truncated: list.truncated
    }
  })

  ipcMain.handle(IPC.DestinationPick, async () => {
    const win = deps.getWindow()
    const res = await dialog.showOpenDialog(win!, {
      title: 'Choose extraction destination',
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0] ?? null
  })

  ipcMain.handle(IPC.DestinationStat, async (_e, raw: unknown) => {
    const p = assertAbsolutePath((raw as { path?: string })?.path, 'path')
    const { statSync, accessSync, constants } = await import('node:fs')
    let exists = false
    let writable = false
    try {
      exists = statSync(p).isDirectory()
      if (exists) accessSync(p, constants.W_OK)
      writable = exists
    } catch {
      writable = false
    }
    const vol = await volumeFor(p)
    return {
      path: p,
      exists,
      writable,
      freeBytes: vol?.freeBytes,
      totalBytes: vol?.totalBytes,
      volumeIsEjectable: vol?.ejectableHint,
      volumeRoot: vol?.mountPath
    }
  })

  ipcMain.handle(IPC.JobStart, async (_e, raw: unknown): Promise<JobRecord> => {
    const req = raw as Parameters<typeof orchestrator.startJob>[0]
    if (!req || typeof req !== 'object') throw new Error('invalid job request')
    assertAbsolutePath(req.archivePath, 'archivePath')
    assertAbsolutePath(req.options.destination, 'destination')
    if (typeof req.options.preTest !== 'boolean' || typeof req.options.keepSuccessfulOnFailure !== 'boolean') {
      throw new Error('invalid job options')
    }
    if (req.password !== undefined && typeof req.password !== 'string') throw new Error('invalid password')
    return orchestrator.startJob(req)
  })

  ipcMain.handle(IPC.JobCancel, async (_e, raw: unknown) => {
    const jobId = (raw as { jobId?: string })?.jobId
    if (typeof jobId !== 'string') throw new Error('invalid jobId')
    return orchestrator.cancelJob(jobId)
  })

  ipcMain.handle(IPC.JobGet, async (_e, raw: unknown) => {
    const jobId = (raw as { jobId?: string })?.jobId
    if (typeof jobId !== 'string') throw new Error('invalid jobId')
    return orchestrator.getJob(jobId)
  })

  ipcMain.handle(IPC.JobList, async () => ({ jobs: await orchestrator.listJobs() }))

  ipcMain.handle(IPC.JobCleanup, async (_e, raw: unknown) => {
    const req = raw as JobCleanupRequest
    if (typeof req?.jobId !== 'string' || (req.mode !== 'remove-temp' && req.mode !== 'forget')) {
      throw new Error('invalid cleanup request')
    }
    return orchestrator.cleanupJob(req.jobId, req.mode)
  })

  ipcMain.handle(IPC.JobOpenFolder, async (_e, raw: unknown) => {
    const jobId = (raw as { jobId?: string })?.jobId
    if (typeof jobId !== 'string') throw new Error('invalid jobId')
    await orchestrator.openInFinder(jobId, false)
  })

  ipcMain.handle(IPC.JobOpenPartial, async (_e, raw: unknown) => {
    const jobId = (raw as { jobId?: string })?.jobId
    if (typeof jobId !== 'string') throw new Error('invalid jobId')
    await orchestrator.openInFinder(jobId, true)
  })

  ipcMain.handle(IPC.DiagnosticsGet, async (): Promise<DiagnosticsResponse> => {
    const avail = await engineAvailability()
    const dest = settings.get().defaultDestination ?? app.getPath('home')
    const vol = await volumeFor(dest)
    return {
      app: {
        version: app.getVersion(),
        electron: process.versions.electron ?? '',
        chrome: process.versions.chrome ?? '',
        node: process.versions.node ?? '',
        platform: process.platform,
        arch: process.arch
      },
      engines: [...avail.values()].map((a) => ({
        id: a.id,
        available: a.available,
        version: a.version ?? undefined,
        path: a.path ?? undefined,
        error: a.error
      })),
      jobsDir: (orchestrator as unknown as { store: { directory: string } }).store.directory,
      logDir: logger.directory,
      recentLogLines: logger.recentLines(300),
      destinationDefaults: { freeBytes: vol?.freeBytes ?? 0, homeDir: app.getPath('home') }
    }
  })

  ipcMain.handle(IPC.SettingsGet, async () => settings.get())
  ipcMain.handle(IPC.SettingsSet, async (_e, patch: unknown) => {
    if (!patch || typeof patch !== 'object') throw new Error('invalid settings patch')
    return settings.set(patch as Record<string, never>)
  })

  ipcMain.handle(IPC.AppInfo, async () => ({
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? '',
    platform: process.platform,
    arch: process.arch
  }))

  // Allow the renderer to reveal files in Finder (archive or output).
  ipcMain.handle('archive:reveal', async (_e, raw: unknown) => {
    const p = assertAbsolutePath((raw as { path?: string })?.path, 'path')
    shell.showItemInFolder(p)
  })

  logger.info('ipc', 'IPC handlers registered')
}

export function humanSize(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let v = bytes
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v >= 100 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`
}
