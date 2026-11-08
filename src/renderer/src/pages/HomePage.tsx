import { useCallback, useEffect, useRef, useState } from 'react'
import { FileArchive, FolderOpen, Lock, Loader2, ShieldCheck, TriangleAlert, UploadCloud, CircleCheckBig, CircleX, FolderOutput, RotateCcw } from 'lucide-react'
import { useAppStore } from '../stores/app-store'
import { unbox } from '../lib/unbox-api'
import { formatBytes, basename } from '../lib/format'
import { formatLabel } from '@shared/formats'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Card } from '../components/ui/card'
import { ProgressLinear, ProgressRing } from '../components/ui/progress'
import { Separator } from '../components/ui/misc'
import { cn } from '../lib/utils'

/**
 * Home = the full extraction flow: drop → inspect → configure → run →
 * completion report. Stages are driven by real IPC state, never timers.
 */
export function HomePage(): React.JSX.Element {
  const stage = useAppStore((s) => s.homeStage)
  if (stage === 'extracting') return <ExtractionView />
  if (stage === 'completed') return <CompletionView />
  return stage === 'ready' ? <ReadyView /> : <IdleView />
}

// ---------------------------------------------------------------------------
// Idle: the drop zone
// ---------------------------------------------------------------------------

function IdleView(): React.JSX.Element {
  const setInspect = useAppStore((s) => s.setInspect)
  const setInspecting = useAppStore((s) => s.setInspecting)
  const inspecting = useAppStore((s) => s.inspecting)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const inspect = useCallback(
    async (paths: string[]) => {
      setError(null)
      if (paths.length === 0) return
      setInspecting(true)
      try {
        const first = paths[0]
        if (!first) return
        const result = await unbox.inspectArchive(first)
        if (result.format === 'unknown') {
          setError(`“${basename(first)}” is not a recognizable archive.`)
          return
        }
        setInspect(result)
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setInspecting(false)
      }
    },
    [setInspect, setInspecting]
  )

  // Menu-driven open (⌘O).
  useEffect(() => {
    const open = (): void => {
      void unbox.pickArchives().then(inspect)
    }
    const pick = (): void => {
      void unbox.pickDestination().then((d) => {
        if (d) void useAppStore.getState().setDestination(d)
      })
    }
    document.addEventListener('unbox:open-archive', open)
    document.addEventListener('unbox:pick-destination', pick)
    return () => {
      document.removeEventListener('unbox:open-archive', open)
      document.removeEventListener('unbox:pick-destination', pick)
    }
  }, [inspect])

  return (
    <div className="rise-in mx-auto flex h-full max-w-2xl flex-col items-center justify-center gap-6">
      <div
        role="button"
        tabIndex={0}
        aria-label="Drop an archive here or click to browse"
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click()
        }}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          void inspect([...e.dataTransfer.files].map((f) => unbox.pathForFile(f)).filter(Boolean))
        }}
        className={cn(
          'glass-panel group flex h-72 w-full cursor-pointer flex-col items-center justify-center gap-4 rounded-3xl transition-all duration-200',
          dragOver && 'scale-[1.015] border-primary/50 bg-primary/[0.06] shadow-lg'
        )}
      >
        {inspecting ? (
          <Loader2 className="size-12 animate-spin text-primary" strokeWidth={1.6} />
        ) : (
          <div className="flex size-20 items-center justify-center rounded-2xl bg-primary/10 transition-transform duration-200 group-hover:scale-105">
            <UploadCloud className="size-10 text-primary" strokeWidth={1.7} />
          </div>
        )}
        <div className="text-center">
          <div className="text-lg font-semibold tracking-tight">
            {inspecting ? 'Reading archive…' : 'Drop an archive here'}
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            or <span className="font-medium text-primary">browse your Mac</span> · zip, 7z, rar, tar, iso, cab, wim & more
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])].map((f) => unbox.pathForFile(f)).filter(Boolean)
            void inspect(files)
            e.target.value = ''
          }}
        />
      </div>

      {error && (
        <div className="glass-panel flex items-center gap-2.5 rounded-xl px-4 py-3 text-sm text-destructive" role="alert">
          <TriangleAlert className="size-4 shrink-0" />
          {error}
        </div>
      )}

      <p className="max-w-md text-center text-xs leading-relaxed text-muted-foreground">
        Files are extracted through native engines with per-entry integrity checks. Unbox never
        deletes your archives and never overwrites existing folders.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Ready: archive details + destination + extract
// ---------------------------------------------------------------------------

function ReadyView(): React.JSX.Element {
  const inspect = useAppStore((s) => s.inspect)!
  const destination = useAppStore((s) => s.destination)
  const destinationFree = useAppStore((s) => s.destinationFree)
  const setDestination = useAppStore((s) => s.setDestination)
  const passwordRequired = useAppStore((s) => s.passwordRequired)
  const password = useAppStore((s) => s.password)
  const setPassword = useAppStore((s) => s.setPassword)
  const settings = useAppStore((s) => s.settings)
  const resetHome = useAppStore((s) => s.resetHome)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  const insufficient = inspect.listing?.totalUncompressed !== undefined && destinationFree !== null && destinationFree < inspect.listing.totalUncompressed * 1.05

  const start = useCallback(async () => {
    if (!destination || !inspect) return
    setStarting(true)
    setStartError(null)
    try {
      const record = await unbox.startJob({
        archivePath: inspect.path,
        password: password ?? undefined,
        options: {
          destination,
          overwritePolicy: settings?.confirmOverwriteConflicts === false ? 'auto-rename' : 'ask',
          preTest: settings?.preTest ?? true,
          keepSuccessfulOnFailure: settings?.keepSuccessfulOnFailure ?? true
        }
      })
      useAppStore.setState({ activeJobId: record.id, activeProgress: record.progress, homeStage: 'extracting' })
    } catch (err) {
      setStartError((err as Error).message)
    } finally {
      setStarting(false)
    }
  }, [destination, inspect, password, settings])

  return (
    <div className="rise-in mx-auto flex h-full max-w-2xl flex-col justify-center gap-4 py-2">
      <Card className="overflow-hidden">
        <div className="flex items-start gap-4 p-5">
          <div className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <FileArchive className="size-7 text-primary" strokeWidth={1.7} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold tracking-tight" data-selectable>
              {basename(inspect.path)}
            </div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground" data-selectable title={inspect.path}>
              {inspect.path}
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <Badge variant="default">{inspect.format === 'unknown' ? 'unknown' : formatLabel(inspect.format)}</Badge>
              <Badge variant="neutral">{inspect.humanSize}</Badge>
              {inspect.confidence === 'extension' && <Badge variant="warning">identified by extension</Badge>}
              {inspect.listing && (
                <Badge variant="neutral">
                  {inspect.listing.fileCount.toLocaleString()} files
                </Badge>
              )}
              {inspect.listing?.encrypted && (
                <Badge variant="warning">
                  <Lock className="size-3" /> encrypted
                </Badge>
              )}
              {inspect.multiVolumeHint && <Badge variant="neutral">multi-volume</Badge>}
            </div>
          </div>
          <button
            onClick={resetHome}
            aria-label="Choose a different archive"
            className="ring-focus rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <RotateCcw className="size-4" />
          </button>
        </div>

        {inspect.listing?.totalUncompressed !== undefined && (
          <>
            <Separator />
            <div className="flex items-center gap-2 px-5 py-3 text-xs text-muted-foreground">
              <ShieldCheck className="size-3.5 text-[var(--color-success)]" />
              expands to {formatBytes(inspect.listing.totalUncompressed)}
              {inspect.listing.encrypted && ' · password required'}
            </div>
          </>
        )}
        {inspect.errors.length > 0 && (
          <>
            <Separator />
            <div className="space-y-1 px-5 py-3 text-xs text-destructive" role="alert">
              {inspect.errors.map((e, i) => (
                <div key={i}>{e}</div>
              ))}
            </div>
          </>
        )}
      </Card>

      <Card className="p-5">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[13px] font-semibold">Destination</span>
          <Button variant="secondary" size="sm" onClick={() => void unbox.pickDestination().then((d) => {
            if (d) void unbox.statDestination(d).then((st) => setDestination(d, st.freeBytes ?? null))
          })}>
            <FolderOpen className="size-3.5" /> Choose…
          </Button>
        </div>
        {destination ? (
          <div className="space-y-1">
            <div className="truncate text-sm" data-selectable title={destination}>
              {destination}
            </div>
            {destinationFree !== null && (
              <div className={cn('text-xs', insufficient ? 'text-destructive' : 'text-muted-foreground')}>
                {formatBytes(destinationFree)} free{insufficient && ' · not enough space for this archive'}
              </div>
            )}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">Choose where the extracted folder should be created.</div>
        )}

        {passwordRequired && (
          <div className="mt-4">
            <label className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold">
              <Lock className="size-3.5" /> Archive password
            </label>
            <input
              type="password"
              value={password ?? ''}
              onChange={(e) => setPassword(e.target.value === '' ? null : e.target.value)}
              placeholder="Required to extract this archive"
              autoComplete="off"
              className="ring-focus glass-subtle h-9 w-full rounded-lg border border-input px-3 text-sm outline-none placeholder:text-muted-foreground/70"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              The password stays in memory and is never written to logs or history.
            </p>
          </div>
        )}
      </Card>

      {startError && (
        <div className="glass-panel flex items-center gap-2.5 rounded-xl px-4 py-3 text-sm text-destructive" role="alert">
          <TriangleAlert className="size-4 shrink-0" /> {startError}
        </div>
      )}

      <Button size="lg" disabled={!destination || starting || (passwordRequired && !password)} onClick={() => void start()} className="w-full">
        {starting ? <Loader2 className="size-4 animate-spin" /> : <FolderOutput className="size-4" />}
        Extract Here
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Extracting: live progress
// ---------------------------------------------------------------------------

function ExtractionView(): React.JSX.Element {
  const progress = useAppStore((s) => s.activeProgress)
  const inspect = useAppStore((s) => s.inspect)
  const cancel = useCallback(async () => {
    const id = useAppStore.getState().activeJobId
    if (id) await unbox.cancelJob(id)
  }, [])

  const p = progress
  const totalsKnown = p?.totalsKnown ?? false
  const percent = totalsKnown && p?.bytesTotal && p.bytesTotal > 0 ? Math.min(100, (p.bytesDone / p.bytesTotal) * 100) : undefined

  return (
    <div className="rise-in mx-auto flex h-full max-w-2xl flex-col items-center justify-center gap-6">
      <ProgressRing value={percent} indeterminate={!totalsKnown} size={168}>
        <div className="text-2xl font-semibold tabular-nums tracking-tight">
          {totalsKnown && percent !== undefined ? `${Math.floor(percent)}%` : '…'}
        </div>
        <div className="mt-0.5 text-[11px] uppercase tracking-wider text-muted-foreground">
          {p?.state === 'testing' ? 'testing' : p?.state === 'verifying' ? 'verifying' : p?.state === 'finalizing' ? 'finalizing' : p?.state === 'preflight' ? 'preparing' : 'extracting'}
        </div>
      </ProgressRing>

      <Card className="w-full p-5">
        <ProgressLinear value={percent} indeterminate={!totalsKnown} />
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2.5 text-sm">
          <Row label="File" value={p?.currentFile ? truncateMiddle(p.currentFile, 42) : '—'} mono />
          <Row label="Status" value={p?.phaseDetail ?? (totalsKnown ? 'streaming' : 'unknown total size — showing bytes processed')} />
          <Row label="Extracted" value={`${formatBytes(p?.bytesDone)}${totalsKnown ? ` of ${formatBytes(p?.bytesTotal)}` : ''}`} />
          <Row label="Files" value={`${(p?.filesDone ?? 0).toLocaleString()}${p?.filesTotal !== undefined ? ` / ${p.filesTotal.toLocaleString()}` : ''}`} />
          <Row label="Speed" value={formatSpeedText(p?.bytesPerSecond)} />
          <Row label="Elapsed" value={formatElapsed(p?.elapsedMs)} />
          <Row label="Remaining" value={totalsKnown && p?.etaMs !== undefined ? formatElapsed(p.etaMs) : 'estimating…'} />
          <Row label="Archive" value={inspect ? basename(inspect.path) : '—'} mono />
        </dl>
      </Card>

      <Button variant="destructive" size="lg" onClick={() => void cancel()}>
        Cancel Extraction
      </Button>
      <p className="text-xs text-muted-foreground">
        Cancellation is safe — partial files are kept in a temporary folder and reported in History.
      </p>
    </div>
  )
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): React.JSX.Element {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('text-right tabular-nums', mono && 'font-mono text-xs leading-5')} title={value}>
        {value}
      </dd>
    </>
  )
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

function CompletionView(): React.JSX.Element {
  const record = useAppStore((s) => s.lastRecord)
  const resetHome = useAppStore((s) => s.resetHome)
  if (!record) {
    resetHome()
    return <IdleView />
  }

  const ok = record.state === 'completed'
  const warned = record.state === 'completed-with-warnings'
  const failed = !ok && !warned

  return (
    <div className="rise-in mx-auto flex h-full max-w-2xl flex-col items-center justify-center gap-5">
      <div
        className={cn(
          'flex size-20 items-center justify-center rounded-2xl',
          ok && 'bg-[var(--color-success)]/12',
          warned && 'bg-[var(--color-warning)]/12',
          failed && 'bg-destructive/12'
        )}
      >
        {ok && <CircleCheckBig className="size-10 text-[var(--color-success)]" strokeWidth={1.7} />}
        {warned && <TriangleAlert className="size-10 text-[var(--color-warning)]" strokeWidth={1.7} />}
        {failed && <CircleX className="size-10 text-destructive" strokeWidth={1.7} />}
      </div>

      <div className="text-center">
        <div className="text-xl font-semibold tracking-tight">
          {ok && 'Extraction complete'}
          {warned && 'Completed with warnings'}
          {failed && 'Extraction failed'}
        </div>
        <div className="mt-1 text-sm text-muted-foreground">
          {basename(record.archivePath)}
          {(record.state === 'cancelled' || record.failureReason) && (
            <> · {record.state === 'cancelled' ? 'cancelled' : record.failureReason}</>
          )}
        </div>
      </div>

      <Card className="w-full p-5">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 text-sm">
          <Row label="Files extracted" value={(record.stats?.filesExtracted ?? 0).toLocaleString()} />
          <Row label="Total size" value={formatBytes(record.stats?.bytesExtracted)} />
          <Row
            label="Verification"
            value={verificationLabel(record)}
          />
          <Row label="Elapsed" value={formatElapsed(record.progress.elapsedMs)} />
        </dl>

        {record.issues.length > 0 && (
          <>
            <Separator className="my-4" />
            <div className="max-h-40 space-y-1.5 overflow-y-auto pr-1" data-selectable>
              {record.issues.slice(0, 30).map((issue, i) => (
                <div key={i} className="flex items-start gap-2 text-xs leading-relaxed">
                  <Badge variant={issue.severity === 'error' ? 'destructive' : 'warning'} className="mt-0.5 shrink-0">
                    {issue.code}
                  </Badge>
                  <span className="text-muted-foreground">{issue.message}</span>
                </div>
              ))}
              {record.issues.length > 30 && (
                <div className="text-xs text-muted-foreground">+ {record.issues.length - 30} more in the full report</div>
              )}
            </div>
          </>
        )}
      </Card>

      <div className="flex gap-2.5">
        {record.outputPath && (
          <Button size="lg" onClick={() => void unbox.openOutputFolder(record.id)}>
            <FolderOpen className="size-4" /> Open Extracted Folder
          </Button>
        )}
        {record.tempPath && (
          <Button variant="secondary" size="lg" onClick={() => void unbox.openPartialFolder(record.id)}>
            Open Partial Files
          </Button>
        )}
        <Button variant="secondary" size="lg" onClick={resetHome}>
          Extract Another
        </Button>
      </div>
    </div>
  )
}

function verificationLabel(record: import('@shared/job-types').JobRecord): string {
  const v = record.verification
  if (!v) return 'not verified'
  switch (v.outcome) {
    case 'crc-verified':
      return '✓ CRC-verified'
    case 'codec-verified':
      return '✓ stream checksums'
    case 'size-verified':
      return '✓ size-verified'
    case 'unverified':
      return 'unverified (format limit)'
    case 'failed':
      return '✗ failed'
  }
}

function formatSpeedText(bps: number | undefined): string {
  if (!bps || bps <= 0) return '—'
  return `${formatBytes(bps)}/s`
}

function formatElapsed(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}h ${m % 60}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s
  const half = Math.floor((max - 1) / 2)
  return `${s.slice(0, half)}…${s.slice(s.length - half)}`
}
