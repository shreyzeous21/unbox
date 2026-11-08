/**
 * Settings — persisted JSON in the app-data dir, atomic writes, validated
 * fields. Defaults are the safe ones (pre-test ON, keep files on failure).
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { SettingsData } from '@shared/ipc-contracts'

const DEFAULTS: SettingsData = {
  defaultDestination: null,
  preTest: true,
  keepSuccessfulOnFailure: true,
  confirmOverwriteConflicts: true,
  concurrencyLimit: 1,
  deleteTempOnCancel: false,
  showNotifications: true
}

export class Settings {
  private data: SettingsData = { ...DEFAULTS }

  constructor(private filePath: string) {}

  async load(): Promise<SettingsData> {
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<SettingsData>
      this.data = { ...DEFAULTS, ...parsed }
    } catch {
      this.data = { ...DEFAULTS }
    }
    return this.data
  }

  get(): SettingsData {
    return this.data
  }

  async set(patch: Partial<SettingsData>): Promise<SettingsData> {
    // Validate ranges defensively.
    if (patch.concurrencyLimit !== undefined) {
      patch.concurrencyLimit = Math.max(1, Math.min(4, Math.floor(patch.concurrencyLimit)))
    }
    if (patch.defaultDestination !== undefined && patch.defaultDestination !== null) {
      const st = await fsp.stat(patch.defaultDestination).catch(() => null)
      if (!st?.isDirectory()) patch.defaultDestination = null
    }
    this.data = { ...this.data, ...patch }
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp-${process.pid}`
    await fsp.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    await fsp.rename(tmp, this.filePath)
    return this.data
  }
}
