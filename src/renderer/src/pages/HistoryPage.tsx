import { useEffect } from 'react'
import { ArchiveRestore, FolderOpen, Trash2, CircleX, TriangleAlert, CircleCheckBig, Clock3, FolderOutput } from 'lucide-react'
import { useAppStore } from '../stores/app-store'
import { unbox } from '../lib/unbox-api'
import { formatBytes, formatDate, basename } from '../lib/format'
import { formatLabel } from '@shared/formats'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Card } from '../components/ui/card'
import { Separator } from '../components/ui/misc'

export function HistoryPage(): React.JSX.Element {
  const history = useAppStore((s) => s.history)
  const setHistory = useAppStore((s) => s.setHistory)

  useEffect(() => {
    void unbox.listJobs().then((r) => setHistory(r.jobs))
  }, [setHistory])

  return (
    <div className="rise-in mx-auto max-w-3xl space-y-4 py-2">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">History</h1>
          <p className="text-sm text-muted-foreground">
            Every job is persisted with its verification outcome. Interrupted jobs keep their partial
            files until you clean them up.
          </p>
        </div>
      </div>

      {history.length === 0 && (
        <Card className="flex flex-col items-center gap-3 p-10 text-center">
          <Clock3 className="size-10 text-muted-foreground/50" strokeWidth={1.5} />
          <div className="text-sm text-muted-foreground">No extractions yet.</div>
        </Card>
      )}

      {history.map((job) => (
        <HistoryRow key={job.id} jobId={job.id} refresh={() => void unbox.listJobs().then((r) => setHistory(r.jobs))} />
      ))}
    </div>
  )
}

function HistoryRow({ jobId, refresh }: { jobId: string; refresh: () => void }): React.JSX.Element | null {
  // Jobs are already in the store; find ours.
  const job = useAppStore((s) => s.history.find((j) => j.id === jobId))
  if (!job) return null

  const icon =
    job.state === 'completed' ? (
      <CircleCheckBig className="size-5 text-[var(--color-success)]" />
    ) : job.state === 'completed-with-warnings' ? (
      <TriangleAlert className="size-5 text-[var(--color-warning)]" />
    ) : job.state === 'interrupted' ? (
      <TriangleAlert className="size-5 text-destructive" />
    ) : (
      <CircleX className="size-5 text-destructive" />
    )

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3.5">
        <div className="mt-0.5">{icon}</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium" data-selectable>
              {basename(job.archivePath)}
            </span>
            <Badge variant="neutral">{job.format === 'unknown' ? '?' : formatLabel(job.format)}</Badge>
            <Badge
              variant={
                job.state === 'completed'
                  ? 'success'
                  : job.state === 'completed-with-warnings'
                    ? 'warning'
                    : 'destructive'
              }
            >
              {job.state}
            </Badge>
            {job.verification?.outcome && (
              <Badge variant="outline">
                {job.verification.outcome === 'crc-verified'
                  ? 'CRC-verified'
                  : job.verification.outcome === 'codec-verified'
                    ? 'stream checksums'
                    : job.verification.outcome === 'size-verified'
                      ? 'size-verified'
                      : job.verification.outcome}
              </Badge>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-muted-foreground" data-selectable>
            <span>{formatDate(job.createdAt)}</span>
            <span>{formatBytes(job.stats?.bytesExtracted ?? 0)}</span>
            <span>{(job.stats?.filesExtracted ?? 0).toLocaleString()} files</span>
            {job.failureReason && <span className="text-destructive">{job.failureReason}</span>}
          </div>
          {job.issues.length > 0 && (
            <div className="mt-2 space-y-1 text-xs text-muted-foreground" data-selectable>
              {job.issues.slice(0, 3).map((iss, i) => (
                <div key={i} className="truncate">
                  · {iss.message}
                </div>
              ))}
              {job.issues.length > 3 && <div>+ {job.issues.length - 3} more</div>}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {job.state === 'interrupted' && job.tempPath && (
            <>
              <Button variant="ghost" size="icon" title="Open partial files" onClick={() => void unbox.openPartialFolder(job.id)}>
                <FolderOutput className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                title="Clean up partial files"
                onClick={() => {
                  void unbox.cleanupJob(job.id, 'remove-temp').then(refresh)
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            </>
          )}
          {job.outputPath && (
            <Button variant="ghost" size="icon" title="Reveal in Finder" onClick={() => void unbox.openOutputFolder(job.id)}>
              <FolderOpen className="size-4" />
            </Button>
          )}
          {job.state !== 'interrupted' && (
            <Button
              variant="ghost"
              size="icon"
              title="Forget this job"
              onClick={() => {
                void unbox.cleanupJob(job.id, 'forget').then(refresh)
              }}
            >
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      </div>
      {job.state === 'interrupted' && (
        <>
          <Separator className="my-3" />
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <ArchiveRestore className="size-3.5" />
            This job was interrupted (app quit or crash). Partial files are preserved in the temporary
            folder — verify contents before trusting them.
          </div>
        </>
      )}
    </Card>
  )
}
