/**
 * Main process entry — app lifecycle, secure window creation, service wiring.
 *
 * Security posture: sandboxed renderer, contextIsolation on, nodeIntegration
 * off, a single validation IPC surface, and navigation locked to the app's own
 * origin. External links open in the user's browser, never in-app.
 */
import { app, BrowserWindow, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { registerIpc } from './ipc'
import { initLogger, log } from './services/logging'
import { JobStore } from './services/extraction/job-store'
import { ExtractionOrchestrator } from './services/extraction/orchestrator'
import { Settings } from './services/settings'
import { buildMenu } from './menu'

// Prevent the app from being multiple-instanced against the same job store.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null
let orchestrator: ExtractionOrchestrator | null = null
let settings: Settings | null = null
/** Archives queued before the window existed (argv + macOS open-file). */
const pendingOpen: string[] = []

const isDev = !!process.defaultApp

function userDataDir(): string {
  return app.getPath('userData')
}

/** Absolute path args that exist on disk (dev: `electron-vite dev -- x.zip`). */
function archiveFromArgv(): string | null {
  const args = process.argv.slice(isDev ? 2 : 1)
  for (const a of args) {
    try {
      if (path.isAbsolute(a) && fs.statSync(a).isFile()) return a
    } catch {
      /* not a path */
    }
  }
  return null
}

function sendOpenArchive(p: string): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:menu', `open-archive-path:${p}`)
  } else {
    pendingOpen.push(p)
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 21 },
    // macOS native vibrancy gives the frosted-glass base layer; the renderer
    // layers its own translucent materials on top (see renderer main.css).
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      v8CacheOptions: 'bypassHeatCheck'
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Lock navigation: only our own page; external links go to the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://') && !url.startsWith('http://localhost')) e.preventDefault()
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  // Deliver argv/open-file archives once the page can receive them.
  mainWindow.webContents.on('did-finish-load', () => {
    const fromArgv = archiveFromArgv()
    if (fromArgv) sendOpenArchive(fromArgv)
    while (pendingOpen.length > 0) {
      const p = pendingOpen.shift()
      if (p) sendOpenArchive(p)
    }
  })
}

app.whenReady().then(async () => {
  const logger = initLogger(path.join(userDataDir(), 'logs'))
  log().info('app', 'starting', { version: app.getVersion(), isDev })

  // macOS: archives opened via Finder/Dock/"Open With".
  app.on('open-file', (e, filePath) => {
    e.preventDefault()
    sendOpenArchive(filePath)
  })

  settings = new Settings(path.join(userDataDir(), 'settings.json'))
  await settings.load()

  const store = new JobStore(path.join(userDataDir(), 'jobs'))
  orchestrator = new ExtractionOrchestrator(
    store,
    logger,
    (event) => {
      mainWindow?.webContents.send('job:event', event)
    },
    () => mainWindow,
    settings.get().concurrencyLimit
  )

  // Crash/crash-kill reconciliation BEFORE the UI can start new jobs.
  const recovered = await orchestrator.recoverAtStartup()
  if (recovered.length > 0) {
    log().warn('app', `recovered ${recovered.length} interrupted job(s) at startup`)
  }

  registerIpc({
    orchestrator,
    settings,
    logger,
    getWindow: () => mainWindow
  })

  buildMenu({
    onNavigate: (route) => mainWindow?.webContents.send('app:menu', `navigate:${route}`),
    onCancel: () => {
      void orchestrator?.cancelJob((orchestrator as unknown as { activeJobId?: string }).activeJobId ?? '')
    }
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // macOS convention: keep running; but jobs must be settled. If a job is
  // running we keep the app alive until the user quits explicitly (or the
  // job finishes and we stay dormant per convention).
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  // Workers are killed by the OS on quit; job records persist in their last
  // truthful state and are reconciled by recoverAtStartup() next launch.
  log().info('app', 'quitting')
})
