import type { FormatId } from '@shared/formats'

/** One entry as reported by an engine's listing. */
export interface EngineListEntry {
  /** Path exactly as stored inside the archive. */
  name: string
  isDir: boolean
  size?: number
  packedSize?: number
  crc?: string
  isSymlink?: boolean
  /** Link target when the listing exposes it. */
  linkTarget?: string
  encrypted?: boolean
}

export interface ListResult {
  entries: EngineListEntry[]
  totalUncompressed?: number
  totalPacked?: number
  fileCount: number
  folderCount: number
  encrypted: boolean
  archiveType?: string
  /** True when the listing was capped (protects against multi-million-entry memory blowups). */
  truncated: boolean
}

export const LIST_HARD_CAP = 500_000

export interface EngineIssue {
  severity: 'warning' | 'error'
  code: string
  message: string
  entry?: string
}

export interface ExtractProgress {
  /** Engine-reported percent 0..100, when the engine provides one. */
  enginePercent?: number
  currentFile?: string
  filesDone?: number
  /** Name of a file the engine just finished writing (7zz '-' markers). */
  fileDone?: string
}

export interface ExtractCallbacks {
  onProgress?: (p: ExtractProgress) => void
  /** Called for every engine stderr/stdout line worth recording. */
  onLog?: (line: string) => void
}

export interface ExtractOptions {
  outDir: string
  password?: string
  signal?: AbortSignal
  callbacks?: ExtractCallbacks
  /** Hard stall watchdog: kill engine if no output AND no fs progress for this long. */
  stallTimeoutMs?: number
}

export interface ExtractResult {
  /** Engine-level success. File-level verification happens in the verification service. */
  ok: boolean
  exitCode: number | null
  signal?: string
  issues: EngineIssue[]
  /** Files the engine reports as completed (when output exposes it). */
  filesCompleted: number
  /** Engine-reported bytes written, when available. */
  bytesWritten?: number
  cancelled: boolean
  passwordPrompted: boolean
  stderrTail: string[]
}

export interface Engine {
  readonly id: string
  /** Absolute binary path, or null when not vendored/available. */
  binaryPath(): string | null
  version(): Promise<string | null>
  supports(format: FormatId): boolean
  list(archivePath: string, opts?: { password?: string; signal?: AbortSignal }): Promise<ListResult>
  test?(archivePath: string, opts: { password?: string; signal?: AbortSignal; callbacks?: ExtractCallbacks }): Promise<{
    ok: boolean
    issues: EngineIssue[]
    cancelled: boolean
  }>
  extract(archivePath: string, opts: ExtractOptions): Promise<ExtractResult>
}

export class CancelledError extends Error {
  constructor(message = 'cancelled') {
    super(message)
    this.name = 'CancelledError'
  }
}
