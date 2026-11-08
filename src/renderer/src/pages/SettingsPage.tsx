import { useEffect } from 'react'
import { FolderOpen } from 'lucide-react'
import { useAppStore } from '../stores/app-store'
import { unbox } from '../lib/unbox-api'
import { formatBytes } from '../lib/format'
import { Button } from '../components/ui/button'
import { Card } from '../components/ui/card'
import { Switch, Label } from '../components/ui/misc'

export function SettingsPage(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const setSettings = useAppStore((s) => s.setSettings)
  const destination = useAppStore((s) => s.destination)
  const destinationFree = useAppStore((s) => s.destinationFree)
  const setDestination = useAppStore((s) => s.setDestination)

  useEffect(() => {
    void unbox.getSettings().then(setSettings)
  }, [setSettings])

  if (!settings) return <div className="p-10 text-sm text-muted-foreground">Loading…</div>

  const patch = (p: Partial<typeof settings>): void => {
    void unbox.setSettings(p).then(setSettings)
  }

  return (
    <div className="rise-in mx-auto max-w-2xl space-y-4 py-2">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Defaults for new extractions. Data-integrity features are on by default.</p>
      </div>

      <Card className="divide-y divide-border">
        <div className="flex items-center justify-between gap-4 p-5">
          <div className="min-w-0">
            <Label htmlFor="dest">Default destination</Label>
            <p className="mt-1 text-xs text-muted-foreground">
              {destination ? (
                <>
                  <span data-selectable>{destination}</span>
                  {destinationFree !== null && ` · ${formatBytes(destinationFree)} free`}
                </>
              ) : (
                'Unbox will ask for a destination each time.'
              )}
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            id="dest"
            onClick={() =>
              void unbox.pickDestination().then((d) => {
                if (d) {
                  patch({ defaultDestination: d })
                  void unbox.statDestination(d).then((st) => setDestination(d, st.freeBytes ?? null))
                }
              })
            }
          >
            <FolderOpen className="size-3.5" /> Choose…
          </Button>
        </div>

        <SettingToggle
          id="pretest"
          title="Test archive before extracting"
          detail="Runs the engine's full integrity pass first (formats that support it). Failures abort before any file is written."
          checked={settings.preTest}
          onChange={(v) => patch({ preTest: v })}
        />
        <SettingToggle
          id="keeppartial"
          title="Keep successful files when extraction fails"
          detail="If some entries fail verification, files that extracted cleanly are preserved and listed."
          checked={settings.keepSuccessfulOnFailure}
          onChange={(v) => patch({ keepSuccessfulOnFailure: v })}
        />
        <SettingToggle
          id="askconflict"
          title="Ask when the output folder already exists"
          detail="Unbox never overwrites existing files; with this off it silently extracts to “name-1” instead of asking."
          checked={settings.confirmOverwriteConflicts}
          onChange={(v) => patch({ confirmOverwriteConflicts: v })}
        />
        <SettingToggle
          id="deltemp"
          title="Delete partial files when cancelling"
          detail="Off by default: cancelled jobs keep their partial files so you can inspect them."
          checked={settings.deleteTempOnCancel}
          onChange={(v) => patch({ deleteTempOnCancel: v })}
        />

        <div className="flex items-center justify-between gap-4 p-5">
          <div>
            <Label htmlFor="concurrency">Parallel extractions</Label>
            <p className="mt-1 text-xs text-muted-foreground">
              Bounded by design: more than 2 concurrent jobs saturate disks and hide I/O errors. 1 is
              recommended for external HDDs.
            </p>
          </div>
          <select
            id="concurrency"
            value={settings.concurrencyLimit}
            onChange={(e) => patch({ concurrencyLimit: Number(e.target.value) })}
            className="ring-focus h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
          >
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      </Card>
    </div>
  )
}

function SettingToggle({
  id,
  title,
  detail,
  checked,
  onChange
}: {
  id: string
  title: string
  detail: string
  checked: boolean
  onChange: (v: boolean) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 p-5">
      <div>
        <Label htmlFor={id}>{title}</Label>
        <p className="mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">{detail}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} aria-label={title} />
    </div>
  )
}
