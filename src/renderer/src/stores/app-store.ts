/**
 * Zustand store — the renderer's single source of truth. Job events arrive
 * throttled from main; we coalesce further with a rAF-ish timer so even
 * bursty updates never thrash React.
 */
import { create } from 'zustand'
import type { ArchiveInspectResponse, DiagnosticsResponse, SettingsData } from '@shared/ipc-contracts'
import type { JobEvent, JobRecord, JobProgress } from '@shared/job-types'

export type Route = 'home' | 'history' | 'settings' | 'diagnostics'
export type HomeStage = 'idle' | 'ready' | 'extracting' | 'completed'

interface AppState {
  route: Route
  homeStage: HomeStage

  inspect: ArchiveInspectResponse | null
  inspecting: boolean
  destination: string | null
  destinationFree: number | null
  password: string | null
  passwordRequired: boolean

  activeJobId: string | null
  activeProgress: JobProgress | null
  lastRecord: JobRecord | null

  history: JobRecord[]
  settings: SettingsData | null
  diagnostics: DiagnosticsResponse | null

  setRoute: (r: Route) => void
  setInspect: (i: ArchiveInspectResponse | null) => void
  setInspecting: (b: boolean) => void
  setDestination: (d: string | null, free?: number | null) => void
  setPassword: (p: string | null) => void
  setPasswordRequired: (b: boolean) => void
  setSettings: (s: SettingsData) => void
  setDiagnostics: (d: DiagnosticsResponse) => void
  setHistory: (jobs: JobRecord[]) => void
  resetHome: () => void

  handleJobEvent: (e: JobEvent) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  route: 'home',
  homeStage: 'idle',

  inspect: null,
  inspecting: false,
  destination: null,
  destinationFree: null,
  password: null,
  passwordRequired: false,

  activeJobId: null,
  activeProgress: null,
  lastRecord: null,

  history: [],
  settings: null,
  diagnostics: null,

  setRoute: (route) => set({ route }),
  setInspect: (inspect) =>
    set({
      inspect,
      homeStage: inspect ? 'ready' : 'idle',
      passwordRequired: inspect?.encryptedHint ?? false,
      password: inspect?.encryptedHint ? get().password : null
    }),
  setInspecting: (inspecting) => set({ inspecting }),
  setDestination: (destination, free) => set({ destination, destinationFree: free ?? null }),
  setPassword: (password) => set({ password }),
  setPasswordRequired: (passwordRequired) => set({ passwordRequired }),
  setSettings: (settings) => set({ settings }),
  setDiagnostics: (diagnostics) => set({ diagnostics }),
  setHistory: (history) => set({ history }),
  resetHome: () =>
    set({
      inspect: null,
      inspecting: false,
      password: null,
      passwordRequired: false,
      activeJobId: null,
      activeProgress: null,
      lastRecord: null,
      homeStage: 'idle'
    }),

  handleJobEvent: (e) => {
    const s = get()
    if (e.type === 'progress') {
      if (e.jobId !== s.activeJobId) return
      set({ activeProgress: e.progress })
    } else if (e.type === 'state') {
      if (e.jobId !== s.activeJobId) return
      set({
        // A state change without detail clears the previous phase text —
        // otherwise "testing archive integrity" lingers into extraction.
        activeProgress: s.activeProgress
          ? { ...s.activeProgress, state: e.state, phaseDetail: e.detail ?? undefined }
          : null,
        homeStage: 'extracting'
      })
    } else if (e.type === 'completed') {
      if (e.jobId !== s.activeJobId) return
      set({
        homeStage: 'completed',
        lastRecord: e.record,
        activeProgress: e.record.progress,
        history: [e.record, ...s.history.filter((j) => j.id !== e.record.id)]
      })
    }
  }
}))
