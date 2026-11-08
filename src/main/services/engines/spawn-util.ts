/**
 * Hardened child-process runner for engine binaries.
 *
 * Security notes:
 * - The archive password is passed via argv (`-p<secret>`) because the 7-Zip
 *   CLI has no fd/stdin password input. The residual risk (same-user process
 *   table visibility) is documented in docs/ARCHITECTURE.md §E. The value is
 *   NEVER logged; args are stored in a scratch array that is emptied after
 *   the process exits.
 * - Engines are spawned with LC_ALL=C for stable parsing and a working
 *   directory inside our own temp workspace (never the user's home).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { CancelledError } from './engine-types'

export interface SpawnResult {
  stdout: string
  stderr: string
  /** Full stdout lines (only when opts.collectStdoutLines). */
  stdoutLines?: string[]
  exitCode: number | null
  signal: string | null
  cancelled: boolean
}

export interface SpawnOpts {
  argv: string[]
  cwd?: string
  password?: string
  signal?: AbortSignal
  /** Feed lines (with % decoding) as they arrive. */
  onStdoutLine?: (line: string) => void
  onStderrLine?: (line: string) => void
  /** Kill the engine if nothing at all is emitted for this long (ms). */
  stallTimeoutMs?: number
  /** Called just before spawn so callers can clear scratch buffers. */
  onExitCleanup?: () => void
  /**
   * Collect EVERY stdout line into result.stdoutLines (bounded at 1.2M).
   * Required for archive LISTINGS: the default CaptureBuffer keeps only an
   * 8MB tail, which would silently truncate multi-hundred-thousand-entry
   * listings.
   */
  collectStdoutLines?: boolean
}

const MAX_CAPTURE = 8 * 1024 * 1024 // 8MB tail per stream, plenty for reports

class CaptureBuffer {
  private parts: string[] = []
  private size = 0
  push(s: string): void {
    this.parts.push(s)
    this.size += s.length
    if (this.size > MAX_CAPTURE) {
      // Keep only the tail.
      const joined = this.parts.join('')
      const tail = joined.slice(joined.length - MAX_CAPTURE / 2)
      this.parts = [tail]
      this.size = tail.length
    }
  }
  toString(): string {
    return this.parts.join('')
  }
}

export function spawnEngine(
  binary: string,
  opts: SpawnOpts,
  label: string
): { proc: ChildProcess; done: Promise<SpawnResult> } {
  // The password slot in argv is filled with the real value only here, at
  // spawn time. Node's spawn rejects NUL bytes in argv, so the placeholder
  // scheme is impossible — callers pass `-p<secret>` pre-assembled and rely
  // on this module to keep it out of any captured/logged output.
  const proc = spawn(binary, opts.argv, {
    cwd: opts.cwd,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let cancelled = false
  const onAbort = (): void => {
    cancelled = true
    // SIGTERM gives the engine a chance to flush; SIGKILL follows below.
    proc.kill('SIGTERM')
    setTimeout(() => {
      if (!proc.killed || proc.exitCode === null) {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }, 1500).unref?.()
  }
  if (opts.signal) {
    if (opts.signal.aborted) onAbort()
    else opts.signal.addEventListener('abort', onAbort, { once: true })
  }

  // Stall watchdog: no output of any kind for N ms → assume wedged disk/engine.
  let watchdog: NodeJS.Timeout | null = null
  if (opts.stallTimeoutMs && opts.stallTimeoutMs > 0) {
    const kick = (): void => {
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }, opts.stallTimeoutMs)
      watchdog.unref?.()
    }
    kick()
    proc.stdout?.on('data', kick)
    proc.stderr?.on('data', kick)
  }

  const stdout = new CaptureBuffer()
  const stderr = new CaptureBuffer()
  const stdoutLines: string[] = []
  const LINE_CAP = 1_200_000

  const pumpLines = (stream: NodeJS.ReadableStream | null, sink: CaptureBuffer, onLine?: (l: string) => void): void => {
    if (!stream) return
    let pending = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      sink.push(chunk)
      if (!onLine) return
      pending += chunk
      const lines = pending.split(/\r\n|\n|\r/)
      pending = lines.pop() ?? ''
      for (const line of lines) onLine(line)
    })
    stream.on('end', () => {
      if (onLine && pending) onLine(pending)
    })
  }

  const stdoutLineHandler = opts.collectStdoutLines
    ? (line: string): void => {
        if (stdoutLines.length < LINE_CAP) stdoutLines.push(line)
        opts.onStdoutLine?.(line)
      }
    : opts.onStdoutLine
  pumpLines(proc.stdout, stdout, stdoutLineHandler)
  pumpLines(proc.stderr, stderr, opts.onStderrLine)

  const done: Promise<SpawnResult> = (async () => {
    let exitCode: number | null = null
    let signal: string | null = null
    try {
      const [code, sig] = (await once(proc, 'close')) as [number, string]
      exitCode = code
      signal = sig
    } catch (err) {
      // 'close' always fires for spawn'd processes; defensive.
      throw new Error(`${label}: engine closed without exit (${String(err)})`)
    } finally {
      if (watchdog) clearTimeout(watchdog)
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
      opts.onExitCleanup?.()
    }
    if (cancelled) {
      // Our abort fired: the exit mode doesn't matter (7-Zip may catch
      // SIGTERM and exit with a code rather than dying by signal) — the
      // user's cancellation is the authoritative outcome.
      throw new CancelledError(`${label} cancelled by user`)
    }
    return {
      stdout: stdout.toString(),
      stderr: stderr.toString(),
      ...(opts.collectStdoutLines ? { stdoutLines } : {}),
      exitCode,
      signal,
      cancelled: false
    }
  })()

  return { proc, done }
}

/**
 * Registers exit listeners at spawn time. events.once() never replays past
 * events — a late `once(proc,'close')` after pipeline completion hangs
 * forever if the process exited during the async gap.
 */
export function childExit(p: ChildProcess): Promise<[number | null, string | null]> {
  return new Promise((resolve) => {
    let settled = false
    const fin = (code: number | null, signal: string | null): void => {
      if (!settled) {
        settled = true
        resolve([code, signal])
      }
    }
    p.once('close', (c, s) => fin(c, s))
    p.once('error', () => fin(null, 'ERROR'))
  })
}
