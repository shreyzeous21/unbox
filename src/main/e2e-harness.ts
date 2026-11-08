/**
 * Electron E2E harness — boots the REAL main-process services inside a real
 * Electron runtime (utilityProcess workers included) and drives full jobs.
 * Not part of the app UI; run via `npm run test:electron`:
 *
 *   electron out/main/e2e-harness.js <archive> <destination> [password]
 *
 * Exits 0 with "E2E PASS" or non-zero with the failure. This is the seam
 * vitest cannot reach: main + worker process boundary + engines.
 */
import { app, BrowserWindow, utilityProcess } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { JobStore } from './services/extraction/job-store'
import { ExtractionOrchestrator } from './services/extraction/orchestrator'
import { initLogger } from './services/logging'

// Referenced so the bundler keeps utilityProcess wiring identical to prod.
void utilityProcess
void BrowserWindow

async function main(): Promise<void> {
  const [, , archiveArg, destArg, passwordArg] = process.argv
  if (!archiveArg || !destArg) {
    console.error('usage: electron e2e-harness.js <archive> <destination> [password]')
    app.exit(2)
    return
  }
  const logger = initLogger(path.join(app.getPath('temp'), 'unbox-e2e-logs'))
  const store = new JobStore(path.join(app.getPath('temp'), 'unbox-e2e-jobs'))
  fs.mkdirSync(destArg, { recursive: true })

  const orchestrator = new ExtractionOrchestrator(
    store,
    logger,
    (event) => {
      if (event.type === 'completed') {
        const r = event.record
        console.log('E2E_RESULT', JSON.stringify({
          state: r.state,
          outcome: r.outcome,
          verification: r.verification?.outcome,
          files: r.stats?.filesExtracted,
          bytes: r.stats?.bytesExtracted,
          issues: r.issues.slice(0, 5).map((i) => `${i.code}: ${i.message}`),
          outputPath: r.outputPath
        }))
        const ok = r.state === 'completed' || r.state === 'completed-with-warnings'
        console.log(ok ? 'E2E PASS' : 'E2E FAIL')
        app.exit(ok ? 0 : 1)
      }
    },
    () => null,
    1
  )

  try {
    await orchestrator.startJob({
      archivePath: archiveArg,
      password: passwordArg,
      options: {
        destination: destArg,
        overwritePolicy: 'auto-rename',
        preTest: true,
        keepSuccessfulOnFailure: true
      }
    })
  } catch (err) {
    console.error('E2E FAIL (start):', (err as Error).message)
    app.exit(1)
  }
}

app.whenReady().then(() => {
  void main()
})
