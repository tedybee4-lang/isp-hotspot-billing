// =============================================================================
//  NETISP network worker.
//
//  A long-lived process that speaks the RouterOS API and drains the platform's
//  job queue. This is the component the platform cannot work without.
//
//  Why a separate process, and not a cron job
//  ------------------------------------------
//  Router management needs three things a serverless invocation cannot provide:
//
//    1. Persistent sockets. The RouterOS API is a stateful binary protocol over
//       TCP. A serverless runtime has no outbound raw TCP at all, and even
//       through WebSocket it must re-handshake for every command. On a 32 MB
//       RB941-2nD that overhead is visible to customers.
//    2. Reliable scheduling. Heartbeats are a promise about time. A cron job
//       that misses its window because the platform was busy reports a router
//       as offline when it is fine.
//    3. Fan-out. Twenty routers cannot be polled inside one HTTP request's
//       lifetime without starving every one of them.
//
//  What it does:
//
//    heartbeat loop   every 30s: queue a heartbeat job per managed router, and
//                     record that this worker is alive
//    job runner       every 5s : claim a batch, execute, record the real result,
//                     retry with backoff on failure
//    health endpoint  127.0.0.1:9090, for the platform and for an operator
//
//  Required environment
//  --------------------
//    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (never the anon key),
//    ROUTER_CREDENTIALS_KEY (must match the Edge Functions), WORKER_NAME.
//  Optional: WORKER_HOSTNAME, WORKER_REGION, WORKER_PUBLIC_IP, WORKER_WG_ADDRESS,
//            WORKER_WG_PUBLIC_KEY, WORKER_HEARTBEAT_SECS, WORKER_HEALTH_PORT,
//            NETISP_TLS_STRICT.
// =============================================================================

import os from 'node:os'
import http from 'node:http'
import { Db } from './db.ts'
import { RouterClient } from './router-client.ts'
import { JobRunner } from './runner.ts'
import { buildHandlers } from './handlers.ts'

const log = (message: string) =>
  console.log(`${new Date().toISOString()} [netisp-worker] ${message}`)

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    // Failing at startup is much better than running for a day doing nothing:
    // the platform would show WORKER OFFLINE with no explanation.
    console.error(`FATAL: ${name} is not set. See worker/README.md.`)
    process.exit(1)
  }
  return value
}

const HEARTBEAT_SECS = Number(process.env.WORKER_HEARTBEAT_SECS ?? 30)
const HEALTH_PORT = Number(process.env.WORKER_HEALTH_PORT ?? 9090)
async function main(): Promise<void> {
  const cfg = {
    url: required('SUPABASE_URL'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    credentialKey: required('ROUTER_CREDENTIALS_KEY'),
    workerName: process.env.WORKER_NAME ?? `worker-${os.hostname()}`,
    hostname: os.hostname(),
    region: process.env.WORKER_REGION,
    publicIp: process.env.WORKER_PUBLIC_IP,
    wgAddress: process.env.WORKER_WG_ADDRESS,
    wgPublicKey: process.env.WORKER_WG_PUBLIC_KEY,
  }

  log(`starting ${cfg.workerName} on ${cfg.hostname} (${os.platform()} ${os.arch()})`)
  log(`node ${process.version}, pid ${process.pid}`)

  const db = new Db(cfg)
  const client = new RouterClient()
  const runner = new JobRunner({
    workerName: cfg.workerName,
    store: db,
    client,
    handlers: buildHandlers(db.handlerContext(), client),
    log,
  })

  // -- heartbeat loop ---------------------------------------------------------
  //
  // Queues one heartbeat per managed router on a fixed cadence, and reports this
  // worker's own liveness. Those are separate concerns: a healthy worker with no
  // routers is still healthy and must not be reported as broken.
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null

  const beat = async () => {
    try {
      const targets = await db.targets()
      // The idempotency key includes the time slot, so a slow pass cannot pile
      // up duplicate heartbeats for the same router.
      const slot = Math.floor(Date.now() / (HEARTBEAT_SECS * 1000))
      for (const target of targets) {
        await db.client.from('router_jobs').insert({
          isp_id: target.ispId,
          node_id: target.nodeId,
          kind: 'heartbeat',
          payload: { source: 'worker_sweep', slot },
          idempotency_key: `sweep:${target.nodeId}:${slot}`,
          priority: 50,
          max_attempts: 2,
        })
      }
      await db.heartbeat({
        jobs_processed: runner.stats.succeeded,
        jobs_failed: runner.stats.failed,
      })
    } catch (err) {
      // Once our own heartbeat lapses the platform shows this worker as
      // offline, which is the honest signal: we cannot reach Supabase.
      log(`heartbeat failed: ${(err as Error).message}`)
      await db.markError((err as Error).message).catch(() => {})
    }
  }

  // -- health endpoint --------------------------------------------------------
  //
  // Localhost only. Reports what the worker is actually doing, and deliberately
  // exposes no credentials, no router addresses and no secrets.
  const health = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      worker: cfg.workerName,
      hostname: cfg.hostname,
      uptime_secs: Math.floor(process.uptime()),
      node: process.version,
      memory_mb: Math.round(process.memoryUsage().rss / 1048576),
      runner: runner.health(),
    }))
  })
  health.listen(HEALTH_PORT, '127.0.0.1', () =>
    log(`health endpoint on 127.0.0.1:${HEALTH_PORT}`))

  // -- run --------------------------------------------------------------------
  await beat()
  heartbeatTimer = setInterval(() => void beat(), HEARTBEAT_SECS * 1000)
  runner.start()
  log('worker is running')

  // -- shutdown ---------------------------------------------------------------
  //
  // Sockets are closed so a router is not left waiting on a dead TCP connection,
  // and the platform is told the worker is draining rather than going silent.
  const shutdown = (signal: string) => {
    log(`${signal} received, shutting down`)
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    runner.stop()
    client.closeAll()
    void (async () => {
      // Best effort on the way out: the process is terminating, so a slow
      // network call must not delay the exit. The `finally` guarantees the
      // process leaves regardless of what the request does.
      try {
        await db.client.from('network_workers')
          .update({ status: 'draining' })
          .eq('name', cfg.workerName)
      } catch { /* we are shutting down; nothing more to do */ }
    })().finally(() => process.exit(0))
    // A slow network call must not hold the process open forever.
    setTimeout(() => process.exit(0), 8000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  // An unhandled rejection means a bug. The worker keeps running so the log
  // shows the pattern, but it does so visibly rather than silently.
  process.on('unhandledRejection', (reason) => {
    log(`unhandled rejection: ${String(reason)}`)
  })
}

main().catch((err) => {
  console.error('FATAL: worker failed to start:', err)
  process.exit(1)
})