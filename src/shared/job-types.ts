/**
 * Job model shared by main, worker, and renderer. A JobRecord is persisted to
 * disk after every transition; it must therefore stay JSON-serializable and
 * forward-compatible (unknown fields ignored on load).
 */

import type { FormatId, IntegrityLevel } from './formats'

export type JobState =
  | 'queued'
  | 'preflight'
  | 'testing'
  | 'listing'
  | 'extracting'
  | 'verifying'
  | 'finalizing'
  | 'completed'
  | 'completed-with-warnings'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type OverwritePolicy = 'auto-rename' | 'ask'
// Note: there is deliberately no 'overwrite' policy — Unbox never destroys
// existing user files.

export interface JobOptions {
  destination: string
  overwritePolicy: OverwritePolicy
  /** Run engine integrity test before extraction (formats that support it). */
  preTest: boolean
  /** On failure, keep files extracted so far (moved to final folder). */
  keepSuccessfulOnFailure: boolean
  /** Optional explicit output folder name (defaults to archive basename). */
  folderName?: string
}

export type JobOutcome =
  | 'ok'
  | 'ok-with-warnings'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface JobIssue {
  severity: 'warning' | 'error'
  code: string
  message: string
  /** Archive entry name, when the issue concerns one entry. */
  entry?: string
}

/** The verification actually achieved — never inferred beyond the format's capability. */
export type VerificationOutcome =
  | 'crc-verified' // per-entry CRC/hash all checked OK (or pre-test + in-stream CRC passed)
  | 'codec-verified' // stream codec checksums OK only
  | 'size-verified' // sizes matched listing, nothing stronger available
  | 'unverified' // nothing stronger than "engine exited 0"
  | 'failed'

export interface JobProgress {
  state: JobState
  phaseDetail?: string
  currentFile?: string
  filesDone: number
  filesTotal?: number
  bytesDone: number
  bytesTotal?: number
  bytesPerSecond?: number
  elapsedMs: number
  etaMs?: number
  /** false ⇒ totals unknown; UI must show indeterminate progress + raw counters. */
  totalsKnown: boolean
}

export interface JobRecord {
  id: string
  createdAt: number
  updatedAt: number
  state: JobState
  archivePath: string
  archiveSize: number
  format: FormatId | 'unknown'
  options: JobOptions
  /** Final output folder (set at finalize time). */
  outputPath?: string
  /** Computed unique final path, fixed before extraction starts. */
  plannedPath?: string
  /** Hidden temp workspace while running/interrupted. */
  tempPath?: string
  progress: JobProgress
  outcome?: JobOutcome
  /** Why a job failed/interrupted — first-class, human readable. */
  failureReason?: string
  verification?: {
    requested: boolean
    outcome: VerificationOutcome
    integrity: IntegrityLevel
    /** Pre-test performed and passed (when capability allows). */
    preTestPassed?: boolean
  }
  stats?: {
    filesExtracted: number
    filesFailed: number
    bytesExtracted: number
    foldersCreated: number
    linksCreated: number
  }
  issues: JobIssue[]
  engine?: { id: string; version: string }
  appVersion: string
}

export interface ExtractionStartRequest {
  archivePath: string
  password?: string
  options: JobOptions
}

/** All events a renderer can receive about a running job. */
export type JobEvent =
  | { type: 'progress'; jobId: string; progress: JobProgress }
  | { type: 'state'; jobId: string; state: JobState; detail?: string }
  | {
      type: 'completed'
      jobId: string
      outcome: JobOutcome
      record: JobRecord
    }
