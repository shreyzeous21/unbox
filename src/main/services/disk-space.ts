/**
 * Disk-space preflight and live checks. Uses fs.statfs (no external calls)
 * so APFS, external SSDs/HDDs and network volumes all behave the same.
 */
import { statfs } from 'node:fs/promises'

export interface VolumeInfo {
  mountPath: string
  freeBytes: number
  totalBytes: number
  /** Heuristic: is this an ejectable/external volume (user-dismountable). */
  ejectableHint: boolean
}

export async function volumeFor(dir: string): Promise<VolumeInfo | null> {
  try {
    const s = await statfs(dir)
    const free = Number(s.bavail) * Number(s.bsize)
    const total = Number(s.blocks) * Number(s.bsize)
    return {
      mountPath: dir,
      freeBytes: free,
      totalBytes: total,
      // Anything under /Volumes is user-mounted (external or network).
      ejectableHint: dir.startsWith('/Volumes/') || !dir.startsWith('/System')
    }
  } catch {
    return null
  }
}

/**
 * Preflight for a job. Estimates required space:
 * - known uncompressed total → total × 1.05 (small safety margin)
 * - unknown (stream formats) → archiveSize × factor (default 4 for tar.xz etc.;
 *   re-checked live every PROGRESS_CHECK_INTERVAL during extraction)
 * plus the fixed metadata overhead per entry observed on APFS.
 */
export const STREAM_FORMAT_UNKNOWN_FACTOR = 4

export interface PreflightResult {
  ok: boolean
  freeBytes: number
  requiredBytes: number
  estimateKnown: boolean
  message?: string
}

export function requiredBytesEstimate(
  knownTotal: number | undefined,
  archiveSize: number,
  fileCount: number
): { bytes: number; known: boolean } {
  if (knownTotal !== undefined && knownTotal > 0) {
    const perEntryOverhead = fileCount * 4096 // APFS minimum allocation granularity
    return { bytes: Math.ceil(knownTotal * 1.05) + perEntryOverhead, known: true }
  }
  return { bytes: archiveSize * STREAM_FORMAT_UNKNOWN_FACTOR, known: false }
}

export async function preflightDiskSpace(
  destination: string,
  knownTotal: number | undefined,
  archiveSize: number,
  fileCount: number
): Promise<PreflightResult> {
  const vol = await volumeFor(destination)
  if (!vol) {
    return { ok: false, freeBytes: 0, requiredBytes: 0, estimateKnown: false, message: `destination volume is not accessible: ${destination}` }
  }
  const est = requiredBytesEstimate(knownTotal, archiveSize, fileCount)
  if (vol.freeBytes < est.bytes) {
    return {
      ok: false,
      freeBytes: vol.freeBytes,
      requiredBytes: est.bytes,
      estimateKnown: est.known,
      message: est.known
        ? `not enough disk space: need ${est.bytes} bytes, ${vol.freeBytes} free`
        : `free space (${vol.freeBytes} bytes) is below the conservative estimate (${est.bytes} bytes) for this archive; extraction will re-check continuously`
    }
  }
  return { ok: true, freeBytes: vol.freeBytes, requiredBytes: est.bytes, estimateKnown: est.known }
}

/**
 * Live re-check during streaming extraction of unknown-size formats.
 * Projects the remaining expansion from the ratio observed so far (the
 * compression ratio of a stream is roughly stable), falling back to the
 * conservative default factor until enough bytes have flowed to measure it.
 */
export async function hasEnoughSpaceFor(
  destination: string,
  archiveConsumed: number,
  archiveTotal: number,
  decompressedSoFar: number
): Promise<boolean> {
  const vol = await volumeFor(destination)
  if (!vol) return false
  const ratio =
    archiveConsumed > 1_000_000
      ? Math.max(1, decompressedSoFar / archiveConsumed)
      : STREAM_FORMAT_UNKNOWN_FACTOR
  const projectedRemaining = Math.max(0, archiveTotal - archiveConsumed) * ratio * 1.1
  return vol.freeBytes > projectedRemaining
}
