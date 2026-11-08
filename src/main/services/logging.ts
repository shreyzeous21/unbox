/**
 * Structured logger for the main process and workers.
 * - Ring buffer in memory (for the Diagnostics page).
 * - JSONL file on disk (rotated daily) for post-mortem analysis.
 * - Redacts any field whose key looks secret-ish; passwords must NEVER be
 *   passed to log calls, but this is defense in depth.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogFields {
  [key: string]: unknown
}

const REDACT_KEYS = /pass|secret|token|credential|pw\b/i

function redact(fields: LogFields): LogFields {
  const out: LogFields = {}
  for (const [k, v] of Object.entries(fields)) {
    out[k] = REDACT_KEYS.test(k) ? '[REDACTED]' : v
  }
  return out
}

export class Logger {
  private ring: string[] = []
  private readonly ringMax = 2000
  private logDir: string

  constructor(logDir: string) {
    this.logDir = logDir
    try {
      mkdirSync(logDir, { recursive: true })
    } catch {
      // Logging must never crash the app.
    }
  }

  get directory(): string {
    return this.logDir
  }

  recentLines(count: number): string[] {
    return this.ring.slice(-count)
  }

  private write(level: LogLevel, scope: string, msg: string, fields?: LogFields): void {
    const entry = {
      ts: new Date().toISOString(),
      level,
      scope,
      msg,
      ...(fields ? redact(fields) : {})
    }
    const line = JSON.stringify(entry)
    this.ring.push(line)
    if (this.ring.length > this.ringMax) this.ring.splice(0, this.ring.length - this.ringMax)

    // Best-effort file persistence; rotate when the day changes or file > 5MB.
    try {
      const file = this.currentFile()
      try {
        if (statSync(file).size > 5 * 1024 * 1024) {
          renameSync(file, `${file}.${Date.now()}.old`)
        }
      } catch {
        /* not present yet */
      }
      appendFileSync(file, line + '\n', 'utf8')
    } catch {
      /* disk trouble: logging must not crash extraction */
    }
  }

  private currentFile(): string {
    const day = new Date().toISOString().slice(0, 10)
    return path.join(this.logDir, `unbox-${day}.log`)
  }

  debug(scope: string, msg: string, fields?: LogFields): void {
    this.write('debug', scope, msg, fields)
  }
  info(scope: string, msg: string, fields?: LogFields): void {
    this.write('info', scope, msg, fields)
  }
  warn(scope: string, msg: string, fields?: LogFields): void {
    this.write('warn', scope, msg, fields)
  }
  error(scope: string, msg: string, fields?: LogFields): void {
    this.write('error', scope, msg, fields)
  }
}

let logger: Logger | null = null

export function initLogger(logDir: string): Logger {
  logger = new Logger(logDir)
  return logger
}

export function log(): Logger {
  if (!logger) {
    // Test/worker fallback: logs kept in memory only.
    logger = new Logger('/tmp/unbox-logs')
  }
  return logger
}
