/**
 * Extraction worker — runs inside an Electron utilityProcess.
 * Owns the engine child processes; streams progress to main over the
 * MessagePort. One job per worker process: a crashed/killed engine or a
 * wedged disk can never poison the next job.
 */
import type { HostToWorker, WorkerToHost } from '../services/extraction/worker-protocol'
import { JobRunner } from '../services/extraction/job-runner'

/**
 * The utilityProcess parent port. Typed structurally so this module stays
 * loadable in plain Node (tests) where Electron's types don't apply.
 */
interface ParentPortLike {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): void
}

type PostFn = (msg: WorkerToHost) => void

function getPort(): { port: ParentPortLike; post: PostFn } {
  const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort
  if (parentPort) {
    return {
      port: parentPort,
      post: (msg) => parentPort.postMessage(msg)
    }
  }
  throw new Error('extraction worker must run inside an Electron utilityProcess (no parentPort)')
}

async function main(): Promise<void> {
  const { port, post } = getPort()
  let runner: JobRunner | null = null

  port.on('message', (event: { data: unknown }) => {
    const msg = event.data as HostToWorker
    if (msg.type === 'start') {
      runner = new JobRunner(msg.req, {
        onProgress: (progress) => post({ type: 'progress', progress }),
        onState: (state, detail) => post({ type: 'state', state, detail }),
        onLog: (line) => post({ type: 'log', line })
      })
      post({ type: 'ready' })
      runner
        .run()
        .then((result) => post({ type: 'result', result }))
        .catch((err: unknown) =>
          post({ type: 'fatal', error: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) })
        )
    } else if (msg.type === 'cancel') {
      runner?.cancel()
    }
  })
}

void main()
