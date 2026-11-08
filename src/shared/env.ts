import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

/**
 * Resolves the vendored engine binaries.
 * - Dev (electron-vite dev / vitest): <repo>/resources/bin
 * - Packaged: <app>.app/Contents/Resources/bin (via process.resourcesPath)
 * UNBOX_DEV_RESOURCES overrides in dev for advanced setups.
 *
 * Electron injects `resourcesPath`/`defaultApp` onto process; we read them
 * structurally so this module typechecks in every context (renderer never
 * executes it).
 */
interface ElectronProcessFields {
  resourcesPath?: string
  defaultApp?: string | boolean
}

export function enginesDir(): string {
  const proc = process as unknown as ElectronProcessFields
  if (process.env.UNBOX_DEV_RESOURCES) return path.join(process.env.UNBOX_DEV_RESOURCES, 'bin')
  // Packaged: <app>.app/Contents/Resources/bin. Only trust it when the
  // engines are actually there — in dev, utilityProcess workers also get
  // resourcesPath (pointing at Electron.app, which has no vendored engines),
  // and must fall through to the walk-up instead.
  if (proc.resourcesPath && !proc.defaultApp) {
    const packagedBin = path.join(proc.resourcesPath, 'bin')
    if (existsSync(path.join(packagedBin, '7zz'))) return packagedBin
  }
  // Walk up from this module looking for the repo's resources/bin — works
  // from src/ (vitest), out/main/ (dev), and out/main/chunks/ (bundled).
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8 && dir !== path.dirname(dir); i++) {
    const candidate = path.join(dir, 'resources', 'bin')
    if (existsSync(candidate)) return candidate
    dir = path.dirname(dir)
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'resources/bin')
}

export function engineBinary(name: '7zz' | 'zstd'): string {
  return path.join(enginesDir(), name)
}

export const LIBARCHIVE_TAR = '/usr/bin/bsdtar'
