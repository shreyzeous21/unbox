/**
 * Preload — the ONLY bridge between the sandboxed renderer and main.
 * Exposes a typed, validated API object; no raw ipcRenderer, no node APIs.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { JobEvent } from '@shared/job-types'
import { IPC, type UnboxApi } from '@shared/ipc-contracts'

const api: UnboxApi = {
  /** Resolves the absolute path of a dropped File (Electron ≥32 removed File.path). */
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  pickArchives: () => ipcRenderer.invoke(IPC.ArchiveOpen),
  pickDestination: () => ipcRenderer.invoke(IPC.DestinationPick),
  inspectArchive: (path) => ipcRenderer.invoke(IPC.ArchiveInspect, { path }),
  listArchive: (path) => ipcRenderer.invoke(IPC.ArchiveList, { path }),
  statDestination: (path) => ipcRenderer.invoke(IPC.DestinationStat, { path }),

  startJob: (req) => ipcRenderer.invoke(IPC.JobStart, req),
  cancelJob: (jobId) => ipcRenderer.invoke(IPC.JobCancel, { jobId }),
  getJob: (jobId) => ipcRenderer.invoke(IPC.JobGet, { jobId }),
  listJobs: () => ipcRenderer.invoke(IPC.JobList),
  cleanupJob: (jobId, mode) => ipcRenderer.invoke(IPC.JobCleanup, { jobId, mode }),
  openOutputFolder: (jobId) => ipcRenderer.invoke(IPC.JobOpenFolder, { jobId }),
  openPartialFolder: (jobId) => ipcRenderer.invoke(IPC.JobOpenPartial, { jobId }),

  getDiagnostics: () => ipcRenderer.invoke(IPC.DiagnosticsGet),
  getSettings: () => ipcRenderer.invoke(IPC.SettingsGet),
  setSettings: (patch) => ipcRenderer.invoke(IPC.SettingsSet, patch),
  getAppInfo: () => ipcRenderer.invoke(IPC.AppInfo),

  onJobEvent: (listener) => {
    const wrapped = (_e: unknown, event: JobEvent): void => listener(event)
    ipcRenderer.on(IPC.JobEvent, wrapped)
    return () => ipcRenderer.removeListener(IPC.JobEvent, wrapped)
  },
  onMenuAction: (listener) => {
    const wrapped = (_e: unknown, action: string): void => listener(action)
    ipcRenderer.on(IPC.AppMenu, wrapped)
    return () => ipcRenderer.removeListener(IPC.AppMenu, wrapped)
  }
}

contextBridge.exposeInMainWorld('unbox', api)
