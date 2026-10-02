// =============================================================================
//  Job runner.
//
//  Claims jobs from `router_jobs` and executes them against routers.
//
//  Concurrency
//  -----------
//  Two claims can never hand out the same job. `claim_router_jobs()` uses
//  `for update skip locked`, so N workers pulling at once receive N disjoint
//  batches with no coordination between them and no separate lock table to keep
//  consistent. The `locked_until` lease is what stops a crashed worker from
//  stranding its jobs.
//
//  Honesty about results
//  ---------------------
//  A job becomes `succeeded` through exactly one path: complete_router_job(),
//  which the worker calls only after the router actually answered. Nothing else
//  may set it. That is what lets the UI say SYNCED and mean the router confirmed,
//  rather than that the platform hoped so.
//
//  Failures
//  --------
//  Transient failures (refused socket, timeout) are retried with exponential
//  backoff. Permanent ones (bad credentials, unsupported feature) are not
//  retried at all, because five attempts against a router with the wrong
//  password helps nobody and tells the ISP nothing.
// =============================================================================

import { RouterClient, type RouterTarget } from './router-client.ts'
import { RouterConnectError, isAuthFailure } from './session.ts'

export interface RouterJob {
  id: string
  isp_id: string
  node_id: string | null
  kind: string
  payload: Record<string, unknown>
  status: string
  attempt_count: number
  max_attempts: number
  timeout_secs: number
}

export interface JobOutcome {
  ok: boolean
  result?: Record<string, unknown>
  /** How long the work took, for the job event log. */
  durationMs: number
  method?: string
  error?: string
  /** False means retrying cannot help. */
  retryable?: boolean
}

export type JobHandler = (
  job: RouterJob,
  target: RouterTarget | null,
) => Promise<JobOutcome>

/** What the runner needs from storage. Implemented over Supabase in db.ts. */
export interface JobStore {
  claim(workerName: string, limit: number, kinds: string[] | null): Promise<RouterJob[]>
  complete(jobId: string, result: Record<string, unknown>, method: string | null,
    durationMs: number): Promise<void>
  fail(jobId: string, error: string, result: Record<string, unknown>,
    method: string | null, durationMs: number, retryable: boolean): Promise<void>
  /** Every router this worker is responsible for, with decrypted credentials. */
  targets(): Promise<RouterTarget[]>
}

export interface RunnerOptions {
  workerName: string
  store: JobStore
  client: RouterClient
  handlers: Record<string, JobHandler>
  batchSize?: number
  intervalMs?: number
  log?: (message: string) => void
}

const DEFAULT_BATCH = 5
const DEFAULT_INTERVAL_MS = 5000
export class JobRunner {
  private readonly batchSize: number
  private readonly intervalMs: number
  private readonly log: (message: string) => void

  private running = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private targetCache = new Map<string, RouterTarget>()
  private targetLoadedAt = 0

  /** Counters for the health endpoint. Nothing here is a lie about success. */
  readonly stats = {
    passes: 0,
    claimed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  }

  constructor(private readonly opts: RunnerOptions) {
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
    this.log = opts.log ?? (() => {})
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.log(`job runner started (worker=${this.opts.workerName})`)
    void this.pass()
  }

  stop(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /**
   * One claim-and-execute cycle.
   *
   * Callable whether or not the loop is running, so a single pass can be driven
   * directly - by a test, or by an operator asking for one immediate sweep.
   * Only the self-rescheduling is gated on `running`.
   */
  async pass(): Promise<void> {
    this.stats.passes += 1
    try {
      await this.refreshTargets()
      const jobs = await this.opts.store.claim(
        this.opts.workerName, this.batchSize, null,
      )
      this.stats.claimed += jobs.length

      // Sequential, not parallel. Each job holds a router session, and five
      // concurrent command bursts against a 32 MB device helps nobody.
      for (const job of jobs) await this.execute(job)
    } catch (err) {
      // A storage or network problem must not kill the loop; the next pass
      // retries, and the platform sees the gap in worker heartbeats.
      this.log(`job runner pass failed: ${(err as Error).message}`)
    } finally {
      if (this.running) this.timer = setTimeout(() => void this.pass(), this.intervalMs)
    }
  }

  private async execute(job: RouterJob): Promise<void> {
    const handler = this.opts.handlers[job.kind]
    if (!handler) {
      // An unknown kind is a platform bug, not a router problem. Failing it
      // immediately is better than retrying something we cannot run at all.
      this.stats.skipped += 1
      await this.opts.store.fail(
        job.id, `No handler is registered for job kind "${job.kind}".`,
        {}, null, 0, false,
      )
      this.log(`job ${job.id}: no handler for kind ${job.kind}`)
      return
    }

    const target = job.node_id ? this.targetCache.get(job.node_id) ?? null : null
    if (job.node_id && !target) {
      // Credentials live encrypted in the database. Without them there is
      // nothing to try, and repeating the attempt cannot produce them.
      await this.opts.store.fail(
        job.id,
        `Router ${job.node_id} has no usable management credentials saved. `
        + 'Save them in the panel, then retry this job.',
        {}, null, 0, false,
      )
      this.stats.failed += 1
      return
    }

    const started = Date.now()
    let outcome: JobOutcome
    try {
      outcome = await withTimeout(
        handler(job, target),
        (job.timeout_secs ?? 60) * 1000,
        `${job.kind} exceeded its ${job.timeout_secs ?? 60}s budget`,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.opts.store.fail(
        job.id, message, {}, null, Date.now() - started, shouldRetry(err),
      )
      this.stats.failed += 1
      this.log(`job ${job.id} (${job.kind}) failed: ${message}`)
      return
    }

    if (outcome.ok) {
      await this.opts.store.complete(
        job.id, outcome.result ?? {}, outcome.method ?? null, outcome.durationMs)
      this.stats.succeeded += 1
      this.log(`job ${job.id} (${job.kind}) succeeded in ${outcome.durationMs}ms`)
    } else {
      await this.opts.store.fail(
        job.id, outcome.error ?? 'Job reported failure',
        outcome.result ?? {}, outcome.method ?? null, outcome.durationMs,
        outcome.retryable ?? true,
      )
      this.stats.failed += 1
      this.log(`job ${job.id} (${job.kind}) failed: ${outcome.error}`)
    }
  }

  /**
   * Router targets change rarely, so they are cached for a minute. Re-reading
   * every pass would be a query per router every five seconds, for data that
   * only changes when an ISP edits a router.
   */
  private async refreshTargets(): Promise<void> {
    if (Date.now() - this.targetLoadedAt < 60_000) return
    const targets = await this.opts.store.targets()
    this.targetCache = new Map(targets.map((t) => [t.nodeId, t]))
    this.targetLoadedAt = Date.now()
  }

  /** Live session count plus pass counters, for the health endpoint. */
  health(): Record<string, unknown> {
    return {
      ...this.stats,
      running: this.running,
      openSessions: this.opts.client.openSessions,
      knownTargets: this.targetCache.size,
    }
  }
}

/** Rejects with a clear message rather than letting a job hang forever. */
export function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    work.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })
}

/**
 * Decides whether a handler failure is worth retrying.
 *
 * Stated once and tested once, rather than as slightly different conditions in
 * each handler.
 */
export function shouldRetry(err: unknown): boolean {
  if (err instanceof RouterConnectError) return err.retryable
  if (isAuthFailure(err as Error)) return false
  return true
}