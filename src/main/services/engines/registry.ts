/**
 * Engine registry — resolves which available engine handles a format, in
 * capability priority order. Availability is probed once and cached.
 */
import type { FormatId } from '@shared/formats'
import { FORMAT_CAPABILITIES, type EngineId } from '@shared/formats'
import type { Engine } from './engine-types'
import { sevenZip } from './sevenzip'
import { libarchive } from './libarchive'
import { zstdEngine } from './zstd'

const ENGINES: Record<EngineId, Engine> = {
  sevenzip: sevenZip,
  libarchive,
  zstd: zstdEngine
}

export interface EngineAvailability {
  id: EngineId
  available: boolean
  version: string | null
  path: string | null
  error?: string
}

let availabilityCache: Map<EngineId, EngineAvailability> | null = null

export async function engineAvailability(): Promise<Map<EngineId, EngineAvailability>> {
  if (availabilityCache) return availabilityCache
  const map = new Map<EngineId, EngineAvailability>()
  for (const [id, engine] of Object.entries(ENGINES) as [EngineId, Engine][]) {
    try {
      const p = engine.binaryPath()
      const v = await engine.version()
      map.set(id, { id, available: !!p && !!v, version: v, path: p })
    } catch (err) {
      map.set(id, {
        id,
        available: false,
        version: null,
        path: engine.binaryPath(),
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
  availabilityCache = map
  return map
}

/** Invalidates the probe cache (used by tests and engine re-fetch). */
export function resetAvailability(): void {
  availabilityCache = null
}

/** Picks the best available engine for a format, or null if none can handle it. */
export async function engineForFormat(format: FormatId): Promise<Engine | null> {
  const caps = FORMAT_CAPABILITIES[format]
  if (!caps) return null
  const avail = await engineAvailability()
  for (const engineId of caps.engines) {
    if (avail.get(engineId)?.available) return ENGINES[engineId]
  }
  return null
}

export function getEngine(id: EngineId): Engine {
  return ENGINES[id]
}

export { sevenZip, libarchive, zstdEngine }
