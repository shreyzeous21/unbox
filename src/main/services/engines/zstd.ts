/**
 * zstd engine adapter — vendored `zstd` CLI (built from pinned upstream
 * source by scripts/fetch-engines.mjs, universal arm64+x64).
 *
 * The zstd CLI cannot produce per-entry listings, so this engine never lists;
 * it only decodes streams:
 *  - `.zst` single file: `zstd -d -c <archive>` piped through the worker into
 *    the destination file. We count output bytes for honest progress.
 *  - `.tar.zst`: zstd stdout is piped into `bsdtar -xf -` (two child
 *    processes joined by Node streams; nothing is buffered in RAM).
 *
 * Integrity: zstd frames may carry an XXH64 content checksum; when present,
 * the CLI verifies it during decode and exits non-zero on mismatch. When
 * absent, only size/post-verification applies. We report this honestly.
 */
import type { FormatId } from '@shared/formats'
import { engineBinary, LIBARCHIVE_TAR } from '@shared/env'
import { createWriteStream } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { childExit } from './spawn-util'
import {
  type Engine,
  type ExtractOptions,
  type ExtractResult,
  type EngineIssue,
  type ListResult
} from './engine-types'
import { CancelledError } from './engine-types'
import { classifyBsdtarError } from './libarchive'

const SUPPORTED: FormatId[] = ['zst', 'tar-zst']

export class ZstdEngine implements Engine {
  readonly id = 'zstd'

  binaryPath(): string | null {
    return engineBinary('zstd')
  }

  async version(): Promise<string | null> {
    const { spawnSync } = await import('node:child_process')
    const res = spawnSync(this.binaryPath() ?? 'zstd', ['--version'], { encoding: 'utf8' })
    const m = /v?([\d.]+)/.exec(res.stdout ?? '')
    return m?.[1] ?? null
  }

  supports(format: FormatId): boolean {
    return SUPPORTED.includes(format)
  }

  /** zstd streams have no entry listing; the orchestrator knows this and never asks. */
  async list(_archivePath: string, _opts?: { signal?: AbortSignal }): Promise<ListResult> {
    throw new Error('zstd streams do not provide listings')
  }

  async extract(archivePath: string, opts: ExtractOptions): Promise<ExtractResult> {
    const bin = this.binaryPath()
    if (!bin) throw new Error('zstd engine not vendored')
    const isTarZst = /\.tar\.zst$|\.tzst$/i.test(archivePath)
    if (isTarZst) return this.extractTarZst(bin, archivePath, opts)
    return this.extractSingleFile(bin, archivePath, opts)
  }

  /** .zst → single output file, streamed via worker pipe (byte-counted). */
  private async extractSingleFile(
    bin: string,
    archivePath: string,
    opts: ExtractOptions
  ): Promise<ExtractResult> {
    const stderrTail: string[] = []
    const base = path.basename(archivePath).replace(/\.zst$/i, '')
    const outPath = path.join(opts.outDir, base)

    const z = spawn(bin, ['-d', '-c', archivePath], {
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let cancelled = false
    const onAbort = (): void => {
      cancelled = true
      z.kill('SIGTERM')
      setTimeout(() => {
        try {
          z.kill('SIGKILL')
        } catch {
          /* gone */
        }
      }, 1500).unref?.()
    }
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    let bytesOut = 0
    let lastProgress = 0
    // Register ALL stream listeners at setup time: 'close'/'end' may fire
    // during any async gap, and events.once/late listeners never replay.
    const exitP = childExit(z)
    const stderrTextP: Promise<string> = z.stderr
      ? readStreamTail(z.stderr, stderrTail)
      : Promise.resolve('')
    const ws = createWriteStream(outPath, { flags: 'wx' }) // never overwrite our own partial
    z.stdout.on('data', (chunk: Buffer) => {
      bytesOut += chunk.length
      const now = Date.now()
      if (now - lastProgress > 100) {
        lastProgress = now
        opts.callbacks?.onProgress?.({ currentFile: base, enginePercent: undefined, filesDone: 0 })
      }
    })

    try {
      // NOTE: stream.promises.pipeline deadlocks with a pre-attached 'data'
      // listener under vitest's transform environment (verified A/B); plain
      // .pipe() + 'finish' is correct in every environment we run.
      await new Promise<void>((resolve, reject) => {
        z.stdout.pipe(ws)
        ws.on('finish', () => resolve())
        ws.on('error', reject)
        z.stdout.on('error', reject)
      })
      const [code] = await exitP
      if (cancelled) throw new CancelledError('zstd cancelled')
      const issues: EngineIssue[] = []
      const stderrText = await stderrTextP
      if (code !== 0) {
        for (const line of stderrText.split(/\r?\n/)) {
          if (line.trim()) issues.push({ severity: 'error', code: classifyZstdError(line), message: line.trim() })
        }
      }
      return {
        ok: code === 0,
        exitCode: code,
        issues,
        filesCompleted: code === 0 ? 1 : 0,
        bytesWritten: bytesOut,
        cancelled: false,
        passwordPrompted: false,
        stderrTail
      }
    } catch (err) {
      if (err instanceof CancelledError || cancelled) {
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
    } finally {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
    }
  }

  /** .tar.zst → zstd | bsdtar, joined in-process; neither archive nor tar ever fully buffered. */
  private async extractTarZst(
    bin: string,
    archivePath: string,
    opts: ExtractOptions
  ): Promise<ExtractResult> {
    await fsp.mkdir(opts.outDir, { recursive: true })
    const stderrTail: string[] = []
    const z = spawn(bin, ['-d', '-c', archivePath], {
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const tar = spawn(LIBARCHIVE_TAR, ['-x', '-f', '-', '-C', opts.outDir, '--no-same-owner'], {
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['pipe', 'ignore', 'pipe']
    })

    let cancelled = false
    const killAll = (): void => {
      cancelled = true
      for (const p of [z, tar]) {
        p.kill('SIGTERM')
        setTimeout(() => {
          try {
            p.kill('SIGKILL')
          } catch {
            /* gone */
          }
        }, 1500).unref?.()
      }
    }
    if (opts.signal) {
      if (opts.signal.aborted) killAll()
      else opts.signal.addEventListener('abort', killAll, { once: true })
    }

    // Count decompressed bytes as they pass through (that's real work done).
    let bytesThrough = 0
    z.stdout.on('data', (c: Buffer) => {
      bytesThrough += c.length
    })
    // Exit listeners registered at pipe setup time, not after completion.
    const zExit = childExit(z)
    const tarExit = childExit(tar)
    z.stdout.pipe(tar.stdin)

    const tarStderr = collectTail(tar.stderr, stderrTail, opts)
    const zStderr = collectTail(z.stderr, stderrTail, opts)

    try {
      const [zCode, tarCode] = await Promise.all([zExit, tarExit])
      if (cancelled) throw new CancelledError('tar.zst cancelled')
      const zText = await zStderr
      const tarText = await tarStderr
      const issues: EngineIssue[] = []
      for (const [text, engine] of [
        [zText, 'zstd'],
        [tarText, 'bsdtar']
      ] as const) {
        for (const line of text.split(/\r?\n/)) {
          const l = line.trim()
          if (!l) continue
          issues.push({
            severity: 'error',
            code: engine === 'zstd' ? classifyZstdError(l) : classifyBsdtarError(l),
            message: `[${engine}] ${l}`
          })
        }
      }
      const ok = zCode[0] === 0 && tarCode[0] === 0 && issues.filter((i) => i.severity === 'error').length === 0
      return {
        ok,
        exitCode: tarCode[0] !== 0 ? tarCode[0] : zCode[0],
        issues,
        filesCompleted: 0,
        bytesWritten: bytesThrough,
        cancelled: false,
        passwordPrompted: false,
        stderrTail
      }
    } catch (err) {
      if (err instanceof CancelledError || cancelled) {
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
    } finally {
      if (opts.signal) opts.signal.removeEventListener('abort', killAll)
    }
  }
}

function collectTail(
  stream: NodeJS.ReadableStream | null,
  tail: string[],
  opts: ExtractOptions
): Promise<string> {
  return new Promise((resolve) => {
    if (!stream) return resolve('')
    let pending = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      tail.push(chunk)
      if (tail.length > 200) tail.shift()
      const lines = (pending + chunk).split(/\r\n|\n|\r/)
      pending = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim()) opts.callbacks?.onLog?.(line)
      }
    })
    stream.on('end', () => resolve(pending))
    stream.on('error', () => resolve(pending))
  })
}

async function readStreamTail(stream: NodeJS.ReadableStream, tail: string[]): Promise<string> {
  return new Promise((resolve) => {
    let all = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      tail.push(chunk)
      if (tail.length > 200) tail.shift()
      all += chunk
    })
    stream.on('end', () => resolve(all))
    stream.on('error', () => resolve(all))
  })
}

export function classifyZstdError(line: string): string {
  const l = line.toLowerCase()
  if (l.includes('checksum') && (l.includes('invalid') || l.includes('corrupted'))) return 'CRC_FAILED'
  if (l.includes('corruption') || l.includes('corrupted')) return 'DATA_ERROR'
  if (l.includes('unknown frame descriptor') || l.includes('not a zstd')) return 'NOT_AN_ARCHIVE'
  if (l.includes('unexpected end')) return 'TRUNCATED'
  if (l.includes('no space left')) return 'DISK_FULL'
  if (l.includes('permission denied')) return 'PERMISSION_DENIED'
  return 'ENGINE_ERROR'
}

export const zstdEngine = new ZstdEngine()
