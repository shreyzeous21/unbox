/**
 * libarchive engine adapter — Apple's system `/usr/bin/bsdtar`
 * (libarchive 3.7.4: zlib / liblzma / bz2lib; NO zstd, NO rar5, NO encryption).
 *
 * Used primarily for tar-family containers where its streaming behavior is
 * excellent. bsdtar already refuses absolute paths and `..` components by
 * default (they're skipped with a stderr warning); we additionally parse
 * those warnings as error-level issues and pre-validate listings in
 * fs-safety. We deliberately never pass `-P` (which would re-enable unsafe
 * paths) and never `--same-owner`.
 */
import type { FormatId } from '@shared/formats'
import { LIBARCHIVE_TAR } from '@shared/env'
import { existsSync } from 'node:fs'
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
import { parseBsdtarTvf } from './output-parser'

const SUPPORTED: FormatId[] = ['tar', 'tar-gz', 'tar-bz2', 'tar-xz', 'cpio', 'gz', 'bz2', 'xz', 'rpm', 'deb', 'xar']

export class LibarchiveEngine implements Engine {
  readonly id = 'libarchive'

  binaryPath(): string | null {
    return existsSync(LIBARCHIVE_TAR) ? LIBARCHIVE_TAR : null
  }

  async version(): Promise<string | null> {
    const { spawnSync } = await import('node:child_process')
    const res = spawnSync(LIBARCHIVE_TAR, ['--version'], { encoding: 'utf8' })
    const m = /bsdtar ([\d.]+)/.exec(res.stdout ?? '')
    return m?.[1] ?? (res.status === 0 ? 'unknown' : null)
  }

  supports(format: FormatId): boolean {
    return SUPPORTED.includes(format)
  }

  async list(archivePath: string, _opts?: { signal?: AbortSignal }): Promise<ListResult> {
    const bin = this.binaryPath()
    if (!bin) throw new Error('bsdtar not available')
    // Single pass: -tvf gives names + sizes + link info in LC_ALL=C stable format.
    const { done } = spawnEngine(
      bin,
      {
        argv: ['-tvf', archivePath],
        signal: _opts?.signal,
        // Full-line collection — see sevenzip.list note.
        collectStdoutLines: true,
        stallTimeoutMs: 120_000
      },
      'bsdtar -tvf'
    )
    const res = await done
    const text = (res.stdoutLines ?? res.stdout.split(/\r?\n/)).join('\n')
    const parsed = parseBsdtarTvf(text)
    if (res.exitCode !== 0 || parsed.errorLines.length > 0) {
      const first = parsed.errorLines[0] ?? `exit ${res.exitCode}`
      if (parsed.list.entries.length === 0) throw new Error(`bsdtar listing failed: ${first}`)
      // Partial listing + errors: return what we saw; orchestrator treats as warning.
      parsed.list.truncated = true
    }
    return parsed.list
  }

  async extract(archivePath: string, opts: ExtractOptions): Promise<ExtractResult> {
    const bin = this.binaryPath()
    if (!bin) throw new Error('bsdtar not available')
    await fsp.mkdir(opts.outDir, { recursive: true })
    const stderrTail: string[] = []
    const { done } = spawnEngine(
      bin,
      {
        argv: ['-x', '-f', archivePath, '-C', opts.outDir, '--no-same-owner'],
        signal: opts.signal,
        stallTimeoutMs: opts.stallTimeoutMs ?? 120_000,
        onStderrLine: (line) => {
          stderrTail.push(line)
          if (stderrTail.length > 200) stderrTail.shift()
          opts.callbacks?.onLog?.(line)
        }
      },
      'bsdtar x'
    )
    try {
      const res = await done
      const issues: EngineIssue[] = []
      for (const line of res.stderr.split(/\r?\n/)) {
        const l = line.trim()
        if (!l) continue
        issues.push({ severity: 'error', code: classifyBsdtarError(l), message: l })
      }
      // bsdtar exit 1 = "unreadable files" or skipped entries; 0 = clean.
      const ok = res.exitCode === 0 && issues.filter((i) => i.severity === 'error').length === 0
      return {
        ok,
        exitCode: res.exitCode,
        signal: res.signal ?? undefined,
        issues,
        filesCompleted: 0, // bsdtar does not report counts; verification service counts from disk
        cancelled: false,
        passwordPrompted: false,
        stderrTail
      }
    } catch (err) {
      if (err instanceof CancelledError) {
        return {
          ok: false,
          exitCode: null,
          signal: 'SIGTERM',
          issues: [{ severity: 'warning', code: 'CANCELLED', message: 'Extraction cancelled by user' }],
          filesCompleted: 0,
          cancelled: true,
          passwordPrompted: false,
          stderrTail
        }
      }
      throw err
    }
  }
}

export function classifyBsdtarError(line: string): string {
  const l = line.toLowerCase()
  if (l.includes('path contains') || l.includes('illegal component') || l.includes('absolute path')) return 'UNSAFE_PATH_SKIPPED'
  if (l.includes('no space left') || l.includes('disk full')) return 'DISK_FULL'
  if (l.includes('permission denied')) return 'PERMISSION_DENIED'
  if (l.includes('truncated') || l.includes('unexpected eof')) return 'TRUNCATED'
  if (l.includes('damaged') || l.includes('checksum error')) return 'DATA_ERROR'
  if (l.includes('operation not permitted')) return 'PERMISSION_DENIED'
  if (l.includes('input/output error') || l.includes('i/o error')) return 'IO_ERROR'
  if (l.includes('could not open') || l.includes('error opening archive')) return 'NOT_AN_ARCHIVE'
  return 'ENGINE_ERROR'
}

export const libarchive = new LibarchiveEngine()
