import { useEffect } from 'react'
import { useAppStore } from './stores/app-store'
import { unbox } from './lib/unbox-api'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { HomePage } from './pages/HomePage'
import { HistoryPage } from './pages/HistoryPage'
import { SettingsPage } from './pages/SettingsPage'
import { DiagnosticsPage } from './pages/DiagnosticsPage'
import { TooltipProvider } from './components/ui/misc'

export default function App(): React.JSX.Element {
  const route = useAppStore((s) => s.route)
  const handleJobEvent = useAppStore((s) => s.handleJobEvent)
  const settings = useAppStore((s) => s.settings)
  const destination = useAppStore((s) => s.destination)
  const setDestination = useAppStore((s) => s.setDestination)

  // Wire IPC event streams once.
  useEffect(() => {
    const offJob = unbox.onJobEvent(handleJobEvent)
    const offMenu = unbox.onMenuAction((action) => {
      if (action.startsWith('open-archive-path:')) {
        // Archive handed over from Finder/Dock/argv.
        const p = action.slice('open-archive-path:'.length)
        void unbox
          .inspectArchive(p)
          .then((result) => {
            useAppStore.getState().setRoute('home')
            useAppStore.getState().setInspect(result)
          })
          .catch(() => {})
      } else if (action.startsWith('navigate:')) {
        const target = action.slice('navigate:'.length)
        if (target === 'home') useAppStore.getState().setRoute('home')
        else if (target === 'history') useAppStore.getState().setRoute('history')
        else if (target === 'settings') useAppStore.getState().setRoute('settings')
        else if (target === 'diagnostics') useAppStore.getState().setRoute('diagnostics')
        else if (target === 'open-archive') void document.dispatchEvent(new CustomEvent('unbox:open-archive'))
        else if (target === 'pick-destination') void document.dispatchEvent(new CustomEvent('unbox:pick-destination'))
      }
    })
    return () => {
      offJob()
      offMenu()
    }
  }, [handleJobEvent])

  // Load settings + defaults once.
  useEffect(() => {
    void (async () => {
      const s = await unbox.getSettings()
      useAppStore.getState().setSettings(s)
      const dest = destination ?? s.defaultDestination
      if (dest) {
        const stat = await unbox.statDestination(dest).catch(() => null)
        if (stat?.writable) setDestination(dest, stat.freeBytes ?? null)
      }
      const jobs = await unbox.listJobs()
      useAppStore.getState().setHistory(jobs.jobs)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full w-full flex-col overflow-hidden text-foreground">
        <TitleBar />
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <main className="min-w-0 flex-1 overflow-y-auto px-6 pb-6 pt-1">
            {route === 'home' && <HomePage />}
            {route === 'history' && <HistoryPage />}
            {route === 'settings' && <SettingsPage />}
            {route === 'diagnostics' && <DiagnosticsPage />}
          </main>
        </div>
        {settings === null && (
          <div className="pointer-events-none fixed inset-x-0 bottom-3 text-center text-xs text-muted-foreground">
            connecting to extraction service…
          </div>
        )}
      </div>
    </TooltipProvider>
  )
}
