/**
 * UI-level E2E harness — dev-only. Boots the REAL window stack (secure
 * BrowserWindow + preload + renderer + IPC + orchestrator + utilityProcess
 * worker) and drives one extraction through the actual UI: it hands the app
 * an archive via the same channel Finder uses (open-archive-path), then
 * clicks the "Extract Here" button in the page. Exits 0 with E2E_UI PASS
 * when the job completes.
 *
 *   electron out/main/ui-e2e.js <archive> <destination>
 */
import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { registerIpc } from './ipc'
import { initLogger } from './services/logging'
import { JobStore } from './services/extraction/job-store'
import { ExtractionOrchestrator } from './services/extraction/orchestrator'

async function main(): Promise<void> {
  const [, , archiveArg, destArg] = process.argv
  if (!archiveArg || !destArg) {
    console.error('usage: electron ui-e2e.js <archive> <destination>')
    app.exit(2)
    return
  }
  const logger = initLogger(path.join(app.getPath('temp'), 'unbox-ui-e2e-logs'))
  const store = new JobStore(path.join(app.getPath('temp'), 'unbox-ui-e2e-jobs'))
  fs.mkdirSync(destArg, { recursive: true })

  let win: BrowserWindow | null = null
  let done = false
  const orchestrator = new ExtractionOrchestrator(
    store,
    logger,
    (event) => {
      // Forward EVERY event to the renderer exactly like the real app does —
      // progress bars must live-update in this harness too.
      if (win && !win.isDestroyed()) win.webContents.send('job:event', event)
      if (event.type === 'completed' && !done) {
        done = true
        const r = event.record
        console.log('E2E_UI_RESULT', JSON.stringify({
          state: r.state,
          verification: r.verification?.outcome,
          files: r.stats?.filesExtracted
        }))
        const ok = r.state === 'completed' || r.state === 'completed-with-warnings'
        console.log(ok ? 'E2E_UI PASS' : 'E2E_UI FAIL')
        // Hold the completion screen briefly so external screenshot tooling
        // can capture it (UNBOX_UI_E2E_HOLD_MS, default 300ms).
        const hold = Number(process.env.UNBOX_UI_E2E_HOLD_MS ?? '300')
        setTimeout(() => app.exit(ok ? 0 : 1), hold)
      }
    },
    () => win,
    1
  )
  registerIpc({
    orchestrator,
    // The UI reads defaultDestination once on mount — point it at the harness
    // destination so the Extract button is enabled.
    settings: {
      get: () => ({ ...DEFAULT_SETTINGS, defaultDestination: destArg }),
      set: async (p: Partial<typeof DEFAULT_SETTINGS>) => ({ ...DEFAULT_SETTINGS, defaultDestination: destArg, ...p })
    } as never,
    logger,
    getWindow: () => win
  })

  win = new BrowserWindow({
    width: 1080,
    height: 720,
    show: true,
    titleBarStyle: 'hiddenInset',
    vibrancy: 'under-window',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  await win.loadFile(path.join(__dirname, '../renderer/index.html'))

  // Hand the archive over exactly like Finder/Dock would, then wait for the
  // Ready screen and click the real Extract button. The event may race the
  // renderer's listener subscription, so re-send until the UI reacts.
  const clickWhenReady = async (): Promise<void> => {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500))
      if (i % 8 === 0) {
        win.webContents.send('app:menu', `open-archive-path:${archiveArg}`)
      }
      try {
        const clicked = await win.webContents.executeJavaScript(`(() => {
          const btns = [...document.querySelectorAll('button')];
          const extract = btns.find(b => b.textContent?.includes('Extract Here') && !b.disabled);
          if (extract) { extract.click(); return true; }
          return false;
        })()`)
        if (clicked) {
          logger.info('ui-e2e', 'Extract Here clicked through the real UI')
          return
        }
      } catch {
        /* page not ready yet */
      }
    }
    console.log('E2E_UI FAIL (Extract button never became clickable)')
    app.exit(1)
  }
  void clickWhenReady()
}

const DEFAULT_SETTINGS = {
  defaultDestination: null,
  preTest: true,
  keepSuccessfulOnFailure: true,
  confirmOverwriteConflicts: false,
  concurrencyLimit: 1,
  deleteTempOnCancel: false,
  showNotifications: true
}

app.whenReady().then(() => {
  void main()
})
