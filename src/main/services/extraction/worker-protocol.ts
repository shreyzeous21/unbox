/**
 * Message contract between the main-process worker host and the
 * utilityProcess extraction worker. Kept Electron-free and importable from
 * both sides.
 */
import type { JobProgress, JobState } from '@shared/job-types'
import type { RunJobRequest, RunJobResult } from './job-runner'

export type HostToWorker = { type: 'start'; req: RunJobRequest } | { type: 'cancel' }

export type WorkerToHost =
  | { type: 'ready' }
  | { type: 'state'; state: JobState; detail?: string }
  | { type: 'progress'; progress: JobProgress }
  | { type: 'log'; line: string }
  | { type: 'result'; result: RunJobResult }
  | { type: 'fatal'; error: string }
