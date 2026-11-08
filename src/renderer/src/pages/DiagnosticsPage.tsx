import { useEffect, useState } from 'react'
import { RefreshCw, CircleCheckBig, CircleX } from 'lucide-react'
import { useAppStore } from '../stores/app-store'
import { unbox } from '../lib/unbox-api'
import { formatBytes } from '../lib/format'
import { Button } from '../components/ui/button'
import { Card } from '../components/ui/card'
import { Badge } from '../components/ui/badge'
import { Separator } from '../components/ui/misc'

export function DiagnosticsPage(): React.JSX.Element {
  const diagnostics = useAppStore((s) => s.diagnostics)
  const setDiagnostics = useAppStore((s) => s.setDiagnostics)
  const [tab, setTab] = useState<'engines' | 'log'>('engines')

  const refresh = (): void => {
    void unbox.getDiagnostics().then(setDiagnostics)
  }
  useEffect(refresh, [setDiagnostics])

  if (!diagnostics) return <div className="p-10 text-sm text-muted-foreground">Loading…</div>

  return (
    <div className="rise-in mx-auto max-w-3xl space-y-4 py-2">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Diagnostics</h1>
          <p className="text-sm text-muted-foreground">Engine health, app versions, and the structured log.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={refresh}>
          <RefreshCw className="size-3.5" /> Refresh
        </Button>
      </div>

      <div className="flex gap-1.5">
        {(['engines', 'log'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={
              t === tab
                ? 'ring-focus rounded-lg bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary'
                : 'ring-focus rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent'
            }
          >
            {t === 'engines' ? 'Engines & App' : 'Log (recent)'}
          </button>
        ))}
      </div>

      {tab === 'engines' && (
        <>
          <Card className="p-5">
            <div className="mb-3 text-[13px] font-semibold">Engines</div>
            <div className="space-y-2.5">
              {diagnostics.engines.map((e) => (
                <div key={e.id} className="flex items-center gap-3 text-sm">
                  {e.available ? (
                    <CircleCheckBig className="size-4 shrink-0 text-[var(--color-success)]" />
                  ) : (
                    <CircleX className="size-4 shrink-0 text-destructive" />
                  )}
                  <span className="font-medium">{e.id}</span>
                  {e.version && <Badge variant="neutral">v{e.version}</Badge>}
                  {e.available ? (
                    <span className="truncate text-xs text-muted-foreground" data-selectable title={e.path}>
                      {e.path}
                    </span>
                  ) : (
                    <span className="text-xs text-destructive">{e.error ?? 'not vendored — run npm run engines:fetch'}</span>
                  )}
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-5">
            <div className="mb-3 text-[13px] font-semibold">App runtime</div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-8 gap-y-1.5 text-sm" data-selectable>
              {[
                ['Unbox', diagnostics.app.version],
                ['Electron', diagnostics.app.electron],
                ['Chromium', diagnostics.app.chrome],
                ['Node', diagnostics.app.node],
                ['Platform', `${diagnostics.app.platform} (${diagnostics.app.arch})`],
                ['Job records', diagnostics.jobsDir],
                ['Logs', diagnostics.logDir],
                ['Home free space', formatBytes(diagnostics.destinationDefaults.freeBytes)]
              ].map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="truncate font-mono text-xs leading-6" title={v}>
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>
        </>
      )}

      {tab === 'log' && (
        <Card className="p-0">
          <Separator className="opacity-0" />
          <pre
            className="max-h-[60vh] overflow-auto p-4 font-mono text-[11px] leading-relaxed text-muted-foreground"
            data-selectable
          >
            {diagnostics.recentLogLines.join('\n') || 'no log lines yet'}
          </pre>
        </Card>
      )}
    </div>
  )
}
