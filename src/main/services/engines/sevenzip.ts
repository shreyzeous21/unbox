/**
 * 7-Zip engine adapter (vendored `7zz` 23.01 universal binary).
 *
 * Integrity model: 7-Zip verifies embedded per-entry CRCs while streaming
 * data to disk and exits non-zero on mismatch. `t` performs a full test pass
 * without writing anything. We parse and classify every error line so the
 * job report states exactly what was and wasn't verified.
 */
import type { FormatId } from '@shared/formats'
import { engineBinary } from '@shared/env'
import fsp from 'node:fs/promises'
import {
  type Engine,
  type ExtractOptions,
  type ExtractResult,
  type EngineIssue,
  type ListResult
} from './engine-types'
import { CancelledError } from './engine-types'
import { spawnEngine } from './spawn-util'
import {
  parseSevenZipSltListing,
  parseSevenZipTestOutput,
  parseSevenZipExtractOutput,
  SevenZipProgressTokenizer
} from './output-parser'

/**
 * Formats this engine handles. The tar family (tar/tar.gz/tar.bz2/tar.xz) is
 * deliberately EXCLUDED: 7-Zip sees compound tar.* as a single inner-tar
 * entry (no recursion), while libarchive lists and extracts individual files
 * in one streaming pass — and bsdtar is always present on macOS.
 */
const SUPPORTED: FormatId[] = [
  'zip', '7z', 'rar', 'gz', 'bz2', 'xz',
  'lzma', 'z', 'iso', 'cab', 'wim', 'arj', 'lzh', 'cpio', 'xar', 'msi', 'rpm', 'deb', 'dmg'
]

const VERSION_CACHE = new Map<string, string>()

export class SevenZipEngine implements Engine {
  readonly id = 'sevenzip'

  binaryPath(): string | null {
    const p = engineBinary('7zz')
    return p
  }

  async version(): Promise<string | null> {
    const bin = this.binaryPath()
    if (!bin) return null
    const cached = VERSION_CACHE.get(bin)
    if (cached) return cached
    const { spawnSync } = await import('node:child_process')
    const res = spawnSync(bin, [], { encoding: 'utf8' })
    const m = /7-Zip \(z\) ([\d.]+)/.exec(res.stdout ?? '')
    const v = m?.[1] ?? null
    if (v) VERSION_CACHE.set(bin, v)
    return v
  }

  supports(format: FormatId): boolean {
    return SUPPORTED.includes(format)
  }

  private argvFor(archivePath: string, password?: string): string[] {
    const base = [archivePath]
    // 7-Zip has no stdin/fd password input; the password lives in argv for
    // the duration of the process (documented residual risk in §E). It is
    // never logged, never persisted, and dropped from memory after exit.
    return password !== undefined ? [`-p${password}`, ...base] : base
  }

  async list(archivePath: string, opts?: { password?: string; signal?: AbortSignal }): Promise<ListResult> {
    const bin = this.binaryPath()
    if (!bin) throw new Error('7zz engine not vendored')
    const argv = ['l', '-slt', ...this.argvFor(archivePath, opts?.password)]
    const { done } = spawnEngine(
      bin,
      {
        argv,
        signal: opts?.signal,
        // Full-line collection: the default 8MB tail buffer would truncate
        // listings of very large archives.
        collectStdoutLines: true,
        // Listing can hang on a dead external drive; watchdog applies.
        stallTimeoutMs: 60_000
      },
      '7zz l'
    )
    const res = await done
    const text = (res.stdoutLines ?? res.stdout.split(/\r?\n/)).join('\n') + (res.stderr ? '\n' + res.stderr : '')
    const parsed = parseSevenZipSltListing(text)
    if (parsed.errorLines.length > 0 && parsed.list.entries.length === 0) {
      throw new Error(`7zz listing failed: ${parsed.errorLines[0] ?? 'unknown error'}`)
    }
    if (res.exitCode !== 0 && parsed.list.entries.length === 0) {
      throw new Error(`7zz listing failed (exit ${res.exitCode})`)
    }
    return parsed.list
  }

  async test(
    archivePath: string,
    opts: { password?: string; signal?: AbortSignal; callbacks?: { onLog?: (l: string) => void } }
  ): Promise<{ ok: boolean; issues: EngineIssue[]; cancelled: boolean }> {
    const bin = this.binaryPath()
    if (!bin) throw new Error('7zz engine not vendored')
    const argv = ['t', '-ba', '-bsp1', ...this.argvFor(archivePath, opts.password)]
    const { done } = spawnEngine(
      bin,
      {
        argv,
        signal: opts.signal,
        onStdoutLine: (l) => opts.callbacks?.onLog?.(l),
        onStderrLine: (l) => opts.callbacks?.onLog?.(l),
        stallTimeoutMs: 120_000
      },
      '7zz t'
    )
    try {
      const res = await done
      const outcome = parseSevenZipTestOutput(res.stdout + '\n' + res.stderr, res.exitCode)
      const issues: EngineIssue[] = outcome.errorLines.map((line) => ({
        severity: /^WARNING:/i.test(line) ? 'warning' : 'error',
        code: classifySevenZipError(line),
        message: line
      }))
      return { ok: outcome.ok, issues, cancelled: false }
    } catch (err) {
      if (err instanceof CancelledError) return { ok: false, issues: [], cancelled: true }
      throw err
    }
  }

  async extract(archivePath: string, opts: ExtractOptions): Promise<ExtractResult> {
    const bin = this.binaryPath()
    if (!bin) throw new Error('7zz engine not vendored')
    // spawn(cwd) ENOENTs if the target dir is missing — create it always.
    await fsp.mkdir(opts.outDir, { recursive: true })
    const argv = [
      'x',
      '-y', // never prompt; conflicts handled by our own destination policy
      '-bsp1', // force progress tokens even when piped (7-Zip's default is tty-only)
      '-snl', // preserve symlinks as links (validated post-extract by fs-safety)
      `-o${opts.outDir}`,
      ...this.argvFor(archivePath, opts.password)
    ]
    const tokenizer = new SevenZipProgressTokenizer()
    let lastPercent: number | undefined
    let filesDone = 0
    let currentFile: string | undefined
    const stderrTail: string[] = []

    const { done } = spawnEngine(
      bin,
      {
        argv,
        cwd: opts.outDir,
        password: opts.password,
        signal: opts.signal,
        stallTimeoutMs: opts.stallTimeoutMs ?? 120_000,
        onStdoutLine: (line) => {
          opts.callbacks?.onLog?.(line)
          for (const t of tokenizer.feed(line + '\n')) {
            if (t.percent !== undefined) lastPercent = t.percent
            if (t.filesDone !== undefined) filesDone = t.filesDone
            if (t.currentFile) currentFile = t.currentFile
            if (t.fileDone) {
              filesDone += 1
              currentFile = t.fileDone
            }
            opts.callbacks?.onProgress?.({
              enginePercent: lastPercent,
              currentFile,
              filesDone
            })
          }
        },
        onStderrLine: (line) => {
          stderrTail.push(line)
          if (stderrTail.length > 200) stderrTail.shift()
          if (line.trim()) opts.callbacks?.onLog?.(line)
        }
      },
      '7zz x'
    )

    try {
      const res = await done
      const summary = parseSevenZipExtractOutput(res.stdout + '\n' + res.stderr, res.exitCode)
      const issues: EngineIssue[] = summary.errorLines.map((line) => ({
        severity: 'error',
        code: classifySevenZipError(line),
        message: line
      }))
      return {
        ok: res.exitCode === 0 && !summary.hasErrors,
        exitCode: res.exitCode,
        signal: res.signal ?? undefined,
        issues,
        filesCompleted: summary.files || filesDone,
        bytesWritten: summary.size,
        cancelled: false,
        passwordPrompted: opts.password !== undefined,
        stderrTail
      }
    } catch (err) {
      if (err instanceof CancelledError) {
        return {
          ok: false,
          exitCode: null,
          signal: 'SIGTERM',
          issues: [{ severity: 'warning', code: 'CANCELLED', message: 'Extraction cancelled by user' }],
          filesCompleted: filesDone,
          cancelled: true,
          passwordPrompted: opts.password !== undefined,
          stderrTail
        }
      }
      throw err
    }
  }
}

/**
 * Classifies a 7-Zip error line into a stable machine code the orchestrator
 * and UI use for messaging and recovery decisions.
 */
export function classifySevenZipError(line: string): string {
  const l = line.toLowerCase()
  if (l.includes('wrong password') || l.includes('cannot open encrypted archive')) return 'WRONG_PASSWORD'
  if (l.includes('crc failed') || l.includes('crc error')) return 'CRC_FAILED'
  if (l.includes('data error')) return 'DATA_ERROR'
  if (l.includes('unexpected end of data') || l.includes('unexpected end of archive')) return 'TRUNCATED'
  if (l.includes('no space left') || l.includes('disk full')) return 'DISK_FULL'
  if (l.includes('cannot find') && l.includes('.7z') ) return 'MISSING_VOLUME'
  if (/cannot find (the )?(volume|archive)/.test(l)) return 'MISSING_VOLUME'
  if (l.includes('permission denied')) return 'PERMISSION_DENIED'
  if (l.includes('read-only') || l.includes('is not accessible')) return 'PERMISSION_DENIED'
  if (l.includes('unsupported') || l.includes('unknown method')) return 'UNSUPPORTED'
  if (l.includes('cannot open the file as archive') || l.includes("can't open as archive")) return 'NOT_AN_ARCHIVE'
  return 'ENGINE_ERROR'
}

export const sevenZip = new SevenZipEngine()
