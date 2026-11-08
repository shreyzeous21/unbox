/**
 * Job store — durable JSON record per job, written ATOMICALLY (tmp+rename)
 * after every state transition. This is what makes crash recovery truthful:
 * a record's state is never ahead of reality on disk.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { JobRecord } from '@shared/job-types'

export class JobStore {
  constructor(private dir: string) {}

  get directory(): string {
    return this.dir
  }

  private file(jobId: string): string {
    // Job ids are app-generated (cuid-like); sanitize defensively anyway.
    const safe = jobId.replace(/[^a-zA-Z0-9_-]/g, '')
    return path.join(this.dir, `${safe}.json`)
  }

  async save(record: JobRecord): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true })
    const target = this.file(record.id)
    const tmp = `${target}.tmp-${process.pid}`
    const json = JSON.stringify(record, null, 2)
    await fsp.writeFile(tmp, json, 'utf8')
    const fh = await fsp.open(tmp, 'r')
    try {
      await fh.sync()
    } finally {
      await fh.close()
    }
    // Re-ensure the dir: a concurrent cleanup (e.g. tests, tmp sweep) must
    // not lose the record — recreate and retry once.
    try {
      await fsp.rename(tmp, target)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        await fsp.mkdir(this.dir, { recursive: true })
        await fsp.writeFile(tmp, json, 'utf8')
        await fsp.rename(tmp, target)
        return
      }
      throw err
    }
  }

  async load(jobId: string): Promise<JobRecord | null> {
    try {
      const raw = await fsp.readFile(this.file(jobId), 'utf8')
      return JSON.parse(raw) as JobRecord
    } catch {
      return null
    }
  }

  async all(): Promise<JobRecord[]> {
    let names: string[]
    try {
      names = await fsp.readdir(this.dir)
    } catch {
      return []
    }
    const out: JobRecord[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try {
        const raw = await fsp.readFile(path.join(this.dir, name), 'utf8')
        out.push(JSON.parse(raw) as JobRecord)
      } catch {
        // Unreadable record: skip but don't hide entirely — recovery scans
        // the temp workspaces too, which is the source of truth for state.
      }
    }
    out.sort((a, b) => b.createdAt - a.createdAt)
    return out
  }

  async delete(jobId: string): Promise<void> {
    await fsp.rm(this.file(jobId), { force: true })
  }
}
