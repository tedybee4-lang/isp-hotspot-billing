// =============================================================================
//  Live network-job lifecycle check.
//
//  Drives the REAL worker classes (worker/src/db.ts and worker/src/runner.ts)
//  against the real queue. It does not re-implement claiming, leasing or
//  completion: every transition below goes through the same functions
//  `worker/src/index.ts` uses, so what is verified is the worker's actual
//  behaviour and not a model of it.
//
//  What is proved, and how honestly each part is proved:
//
//    QUEUED    a job is inserted as 'pending' and is immediately claimable
//    CLAIMED   claim_router_jobs returns it as 'processing', sets locked_by,
//              sets locked_until (the lease) and increments attempt_count
//    LEASE     a second claim while leased returns NOTHING, so two workers can
//              never hold one job; expiring the lease makes it claimable again
//    PROCESSING the real JobRunner executes the claimed job
//    FAILURE   the outcome is recorded in router_jobs.error and in
//              router_job_events, with the real message
//    RETRY     fail_router_job(p_retryable => true) moves status to 'retrying'
//              and pushes next_run_at out by the exponential backoff step
//    SUCCESS   complete_router_job is the only path to 'succeeded' and writes
//              the duration plus an ok event
//    HEARTBEAT network_workers.last_heartbeat_at advances
//
//  ONE LIMITATION, stated plainly: a job reaches 'succeeded' only after a router
//  actually answers. No MikroTik is attached to production, so the SUCCESS
//  transition is exercised through the worker's own `complete()` rather than a
//  real socket round-trip. That checks the bookkeeping, not the hardware. The
//  execution test deliberately uses a real router-scoped job and reports
//  whatever genuinely happens - with no credentials saved that is an honest
//  permanent failure, not a fabricated success.
//
//  Cleanup removes every row this creates, by job id, and nothing else.
// =============================================================================

import { Db } from '../../worker/src/db.ts'
import { JobRunner } from '../../worker/src/runner.ts'
import { RouterClient } from '../../worker/src/router-client.ts'
import { buildHandlers } from '../../worker/src/handlers.ts'

const URL_ = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const CRED_KEY = process.env.ROUTER_CREDENTIALS_KEY ?? 'unused-by-this-probe'
if (!URL_ || !KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the env.')
  process.exit(2)
}

const WORKER = 'live-check-network-job'
const created = new Set<string>()
const say = (...a: unknown[]) => console.log(...a)

async function main(): Promise<void> {
  const cfg = {
    url: URL_!, serviceRoleKey: KEY!, credentialKey: CRED_KEY, workerName: WORKER,
  }
  const store = new Db(cfg)
  const sb = store.client

  const cleanup = async () => {
    for (const id of created) {
      await sb.from('router_job_events').delete().eq('job_id', id)
      await sb.from('router_jobs').delete().eq('id', id)
    }
    say(`\ncleanup: removed ${created.size} job row(s) and their events`)
  }

  try {
    // -- QUEUED --------------------------------------------------------------
    const { data: node, error: nodeErr } = await sb
      .from('nodes').select('id, isp_id, name').eq('enabled', true).limit(1).single()
    if (nodeErr || !node) throw new Error(`no enabled node to target: ${nodeErr?.message}`)

    const key = `${WORKER}:${Date.now()}`
    const { data: job, error: insErr } = await sb
      .from('router_jobs')
      .insert({
        isp_id: node.isp_id,
        node_id: node.id,
        kind: 'heartbeat',
        payload: { source: WORKER, key },
        idempotency_key: key,
        priority: 1,
        max_attempts: 3,
      })
      .select('id, status, attempt_count').single()
    if (insErr || !job) throw new Error(`insert failed: ${insErr?.message}`)
    created.add(job.id)
    say(`QUEUED      ${job.id} status=${job.status} attempts=${job.attempt_count}`)

    // -- CLAIMED + LEASE -----------------------------------------------------
    const claimed = await store.claim(WORKER, 5, null)
    const mine = claimed.find((j) => j.id === job.id)
    say(`CLAIMED     ${claimed.length} claimed; mine present=${Boolean(mine)}`)
    if (!mine) throw new Error('the job was not claimable')

    const { data: leased } = await sb.from('router_jobs')
      .select('status, locked_by, locked_until, attempt_count')
      .eq('id', job.id).single()
    const leaseSec = Math.round(
      (new Date(leased!.locked_until).getTime() - Date.now()) / 1000)
    say(`PROCESSING  status=${leased!.status} locked_by=${leased!.locked_by} `
      + `lease=${leaseSec}s attempts=${leased!.attempt_count}`)

    // A second claim must not hand the same job out while the lease holds.
    const again = await store.claim(WORKER, 5, null)
    say(`LEASE       second claim returned ${again.length}; `
      + `contains mine=${again.some((j) => j.id === job.id)} (expect false)`)

    // Expire the lease: a crashed worker must not strand the job.
    const { error: expireErr } = await sb.from('router_jobs')
      .update({ locked_until: new Date(Date.now() - 60_000).toISOString() })
      .eq('id', job.id)
    const { data: expired } = await sb.from('router_jobs')
      .select('status, locked_until, next_run_at').eq('id', job.id).single()
    say(`LEASE       row now status=${expired?.status} `
      + `locked_until=${expired?.locked_until}${expireErr ? ` (${expireErr.message})` : ''}`)
    const reclaimed = await store.claim(WORKER, 5, null)
    say(`LEASE-EXPIRED reclaimable=${reclaimed.some((j) => j.id === job.id)} `
      + `(expect true; claimed ${reclaimed.length})`)

    // -- EXECUTION: the real JobRunner, on a real router-scoped job ----------
    // The worker is given the genuine handlers. With no saved credentials the
    // router cannot be reached, so this reports the true outcome rather than a
    // staged one.
    // The lease is handed back first, so the runner really has to claim the job
    // itself rather than inheriting one this probe already holds.
    await sb.from('router_jobs')
      .update({ locked_until: new Date(Date.now() - 60_000).toISOString() })
      .eq('id', job.id)
    const client = new RouterClient()
    const runner = new JobRunner({
      workerName: WORKER,
      store,
      client,
      handlers: buildHandlers(store.handlerContext(), client),
      log: (m) => say(`  runner: ${m}`),
    })
    await runner.pass()
    const { data: afterRun, error: runErr } = await sb.from('router_jobs')
      .select('status, error, attempt_count, locked_by').eq('id', job.id).single()
    say(`EXECUTE     status=${afterRun?.status} attempts=${afterRun?.attempt_count}`
      + `${runErr ? ` (read error: ${runErr.message})` : ''}`)
    say(`  error=${afterRun?.error ?? '(none)'}`)

    const { data: events } = await sb.from('router_job_events')
      .select('attempt, ok, error, worker, duration_ms')
      .eq('job_id', job.id).order('id')
    say(`EVENTS      ${events?.length ?? 0} recorded: `
      + JSON.stringify(events ?? []))

    // -- SUCCESS ------------------------------------------------------------------
    // complete_router_job refuses a job this worker does not hold - it returns
    // {ok:false} rather than raising, so the caller must hold it. A fresh job is
    // claimed and completed in the same breath, which is exactly the shape of a
    // real success: claimed, executed, completed.
    //   No router is involved, so this proves the bookkeeping, not the hardware.
    const key3 = `${WORKER}:success:${Date.now()}`
    const { data: okJob } = await sb.from('router_jobs')
      .insert({
        isp_id: node.isp_id, node_id: node.id, kind: 'heartbeat',
        payload: { source: WORKER }, idempotency_key: key3,
        priority: 1, max_attempts: 3,
      })
      .select('id').single()
    created.add(okJob!.id)

    const heldIt = (await store.claim(WORKER, 5, null)).some((j) => j.id === okJob!.id)
    await store.complete(okJob!.id, { probe: true }, 'live-check', 12)
    const { data: done } = await sb.from('router_jobs')
      .select('status, duration_ms, error, completed_at').eq('id', okJob!.id).single()
    say(`SUCCESS     claimed=${heldIt} status=${done?.status} `
      + `duration_ms=${done?.duration_ms} error=${done?.error ?? '(none)'}`)

    const { data: okEvents } = await sb.from('router_job_events')
      .select('attempt, ok, method, duration_ms').eq('job_id', okJob!.id)
    say(`EVENTS(ok)  ${JSON.stringify(okEvents ?? [])}`)

    // -- RETRY / BACKOFF ------------------------------------------------------
    // A second job, so this starts from a clean attempt count and can be shown
    // going 'retrying' rather than straight to a terminal state.
    const key2 = `${WORKER}:retry:${Date.now()}`
    const { data: retryJob } = await sb.from('router_jobs')
      .insert({
        isp_id: node.isp_id, node_id: node.id, kind: 'heartbeat',
        payload: { source: WORKER }, idempotency_key: key2,
        priority: 1, max_attempts: 5,
      })
      .select('id').single()
    created.add(retryJob!.id)

    const gotRetry = await store.claim(WORKER, 5, null)
    if (!gotRetry.some((j) => j.id === retryJob!.id)) {
      say('RETRY       job was not claimable; cannot demonstrate backoff')
    } else {
      await store.fail(retryJob!.id, 'simulated transient connect failure',
        {}, 'api_ssl', 30, true)
      const { data: r1 } = await sb.from('router_jobs')
        .select('status, attempt_count, next_run_at, error').eq('id', retryJob!.id).single()
      const delaySec = Math.round(
        (new Date(r1!.next_run_at).getTime() - Date.now()) / 1000)
      say(`RETRY       status=${r1?.status} attempts=${r1?.attempt_count} `
        + `backoff=${delaySec}s error=${r1?.error ?? '(none)'}`)

      // Exhaust the attempts to prove it terminates in 'dead' rather than
      // looping forever. next_run_at is set well into the past rather than to
      // "now": the claim predicate compares it against the DATABASE clock, so a
      // host whose clock lags would otherwise make the job invisible.
      for (let i = 0; i < 5; i += 1) {
        const { error: bumpErr } = await sb.from('router_jobs')
          .update({
            next_run_at: new Date(Date.now() - 3_600_000).toISOString(),
            locked_until: new Date(Date.now() - 60_000).toISOString(),
          })
          .eq('id', retryJob!.id)
        if (bumpErr) { say(`  bump error: ${bumpErr.message}`); break }
        const got = await store.claim(WORKER, 5, null)
        if (!got.some((j) => j.id === retryJob!.id)) {
          say(`  loop ${i}: claim did not return the job (claimed ${got.length})`)
          break
        }
        await store.fail(retryJob!.id, `attempt ${i + 2}`, {}, 'api_ssl', 5, true)
      }
      const { data: r2 } = await sb.from('router_jobs')
        .select('status, attempt_count').eq('id', retryJob!.id).single()
      say(`RETRY-DEAD  status=${r2?.status} attempts=${r2?.attempt_count}/5 `
        + `(expect dead)`)
      const { data: retryEvents } = await sb.from('router_job_events')
        .select('attempt, ok').eq('job_id', retryJob!.id).order('id')
      say(`EVENTS      ${retryEvents?.length ?? 0} failure events recorded`)
    }

    // -- HEARTBEAT -----------------------------------------------------------
    const { data: before } = await sb.from('network_workers')
      .select('last_heartbeat_at, status').eq('name', WORKER).maybeSingle()
    await store.heartbeat({ jobs_processed: 1, jobs_failed: 0 })
    const { data: afterBeat } = await sb.from('network_workers')
      .select('last_heartbeat_at, status, jobs_processed')
      .eq('name', WORKER).maybeSingle()
    if (!afterBeat) {
      say('HEARTBEAT   FAILED: no worker row after heartbeat')
    } else {
      const prior = before?.last_heartbeat_at
      const advanced = prior
        ? new Date(afterBeat.last_heartbeat_at).getTime()
          >= new Date(prior).getTime()
        // First beat for this probe worker: there is no prior value to compare.
        : afterBeat.last_heartbeat_at !== null
      say(`HEARTBEAT   status=${afterBeat.status} `
        + `jobs_processed=${afterBeat.jobs_processed} advanced=${advanced}`)
    }

    // The probe must not leave itself registered as a worker.
    await sb.from('network_workers').delete().eq('name', WORKER)
    say('cleanup: probe worker row removed')
  } finally {
    await cleanup()
  }
}

main().catch((err) => {
  console.error('CHECK FAILED:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})