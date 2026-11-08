/**
 * The complete, typed IPC surface. The renderer can only do what is exposed
 * here; every request is validated in main before any privileged action.
 */

import type { FormatId } from './formats'
import type { JobRecord, JobEvent, JobOptions, ExtractionStartRequest } from './job-types'

export const IPC = {
  // ---- archive inspection ------------------------------------------------
  ArchiveOpen: 'archive:open', // show open dialog, return picked path(s)
  ArchiveInspect: 'archive:inspect', // magic+size detection + capability report
  ArchiveList: 'archive:list', // full entry listing (cheap-list formats)

  // ---- destination --------------------------------------------------------
  DestinationPick: 'destination:pick',
  DestinationStat: 'destination:stat', // free space, writability, volume info

  // ---- extraction jobs ------------------------------------------------------
  JobStart: 'job:start',
  JobCancel: 'job:cancel',
  JobGet: 'job:get',
  JobList: 'job:list', // history
  JobRecover: 'job:recover', // ask main to reconcile interrupted jobs at startup
  JobCleanup: 'job:cleanup', // remove temp dirs of a dead job
  JobOpenFolder: 'job:open-folder', // reveal output in Finder
  JobOpenPartial: 'job:open-partial',

  // ---- events (main → renderer) ---------------------------------------------
  JobEvent: 'job:event',
  AppMenu: 'app:menu', // menu actions (nav, cancel)

  // ---- system ---------------------------------------------------------------
  DiagnosticsGet: 'diagnostics:get',
  SettingsGet: 'settings:get',
  SettingsSet: 'settings:set',
  AppInfo: 'app:info'
} as const

// ---------- payload types ----------

export interface ArchiveInspectRequest {
  path: string
}
export interface ArchiveInspectResponse {
  path: string
  size: number
  format: FormatId | 'unknown'
  confidence: 'magic' | 'extension' | 'none'
  humanSize: string
  encryptedHint: boolean
  multiVolumeHint: boolean
  /** Missing volume paths for a split archive (e.g. .z01 before .zip). */
  missingVolumes: string[]
  capabilityNotes: string[]
  /** Cheap listing result when the format allows it. */
  listing?: {
    fileCount: number
    folderCount: number
    totalUncompressed?: number
    totalPacked?: number
    encrypted: boolean
    sampleEntries: Array<{ name: string; size?: number; isDir: boolean }>
    truncated: boolean
  }
  errors: string[]
}

export interface DestinationStatResponse {
  path: string
  exists: boolean
  writable: boolean
  freeBytes?: number
  totalBytes?: number
  volumeIsEjectable?: boolean
  volumeRoot?: string
}

export interface JobListResponse {
  jobs: JobRecord[]
}

export interface JobCleanupRequest {
  jobId: string
  /** remove temp dir and mark record cleaned */
  mode: 'remove-temp' | 'forget'
}

export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
}

export interface EngineStatus {
  id: string
  available: boolean
  version?: string
  path?: string
  error?: string
}

export interface DiagnosticsResponse {
  app: AppInfo
  engines: EngineStatus[]
  jobsDir: string
  logDir: string
  recentLogLines: string[]
  destinationDefaults: { freeBytes: number; homeDir: string }
}

export interface SettingsData {
  defaultDestination: string | null
  preTest: boolean
  keepSuccessfulOnFailure: boolean
  confirmOverwriteConflicts: boolean
  concurrencyLimit: number // archives at once (default 1; bounded)
  deleteTempOnCancel: boolean
  showNotifications: boolean
}

/** The single API object exposed to the renderer via contextBridge. */
export interface UnboxApi {
  pathForFile(file: File): string
  pickArchives(): Promise<string[]>
  pickDestination(): Promise<string | null>
  inspectArchive(path: string): Promise<ArchiveInspectResponse>
  listArchive(path: string): Promise<ArchiveInspectResponse['listing'] | null>
  statDestination(path: string): Promise<DestinationStatResponse>

  startJob(req: ExtractionStartRequest): Promise<JobRecord>
  cancelJob(jobId: string): Promise<boolean>
  getJob(jobId: string): Promise<JobRecord | null>
  listJobs(): Promise<JobListResponse>
  cleanupJob(jobId: string, mode: JobCleanupRequest['mode']): Promise<JobRecord | null>
  openOutputFolder(jobId: string): Promise<void>
  openPartialFolder(jobId: string): Promise<void>

  getDiagnostics(): Promise<DiagnosticsResponse>
  getSettings(): Promise<SettingsData>
  setSettings(patch: Partial<SettingsData>): Promise<SettingsData>
  getAppInfo(): Promise<AppInfo>

  onJobEvent(listener: (event: JobEvent) => void): () => void
  onMenuAction(listener: (action: string) => void): () => void
}

export type IpcInvokeMap = {
  [IPC.ArchiveOpen]: { req: void; res: string[] }
  [IPC.ArchiveInspect]: { req: ArchiveInspectRequest; res: ArchiveInspectResponse }
  [IPC.ArchiveList]: { req: { path: string }; res: ArchiveInspectResponse['listing'] | null }
  [IPC.DestinationPick]: { req: void; res: string | null }
  [IPC.DestinationStat]: { req: { path: string }; res: DestinationStatResponse }
  [IPC.JobStart]: { req: ExtractionStartRequest; res: JobRecord }
  [IPC.JobCancel]: { req: { jobId: string }; res: boolean }
  [IPC.JobGet]: { req: { jobId: string }; res: JobRecord | null }
  [IPC.JobList]: { req: void; res: JobListResponse }
  [IPC.JobCleanup]: { req: JobCleanupRequest; res: JobRecord | null }
  [IPC.JobOpenFolder]: { req: { jobId: string }; res: void }
  [IPC.JobOpenPartial]: { req: { jobId: string }; res: void }
  [IPC.DiagnosticsGet]: { req: void; res: DiagnosticsResponse }
  [IPC.SettingsGet]: { req: void; res: SettingsData }
  [IPC.SettingsSet]: { req: Partial<SettingsData>; res: SettingsData }
  [IPC.AppInfo]: { req: void; res: AppInfo }
}

export type JobOptions_ = JobOptions
