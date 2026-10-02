/**
 * Network status dashboard.
 *
 * This screen exists to answer one question honestly: is the network working,
 * and if not, what exactly is wrong?
 *
 * Every value here comes from the backend and every value is labelled by what it
 * actually means:
 *
 *   * ONLINE is computed from a heartbeat inside the router's own offline
 *     threshold, not from a status string. A router with a healthy-looking row
 *     and no heartbeat is OFFLINE here, which is the point.
 *   * Reachability is shown as its own column, because "offline" and "behind
 *     CGNAT with no tunnel" are different problems with different fixes, and
 *     conflating them sends an ISP to reboot a router that is working fine.
 *   * Nothing is shown as a number unless it was measured. Feature counts that
 *     were not reported read "not measured", not "0".
 *
 * No control on this page fakes anything. "Poll now" queues a real job; the
 * row updates when the worker answers.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Radio as RadioIcon, RefreshCw, Users, Activity, Server, ShieldAlert,
  Wifi, WifiOff, Plug, Zap, CircleAlert, Clock,
} from 'lucide-react'
import {
  Alert, Badge, Button, Card, CardHeader, EmptyState, Spinner, StatTile, Table, Td, Th,
} from '../../../components/ui'
import {
  fetchNetworkOverview, fetchQueueOverview, fetchWorkerOverview,
  fetchRouterCapabilities, fetchRouterJobs, requestRouterHeartbeat,
  runRouterDiagnostic, retryRouterJob, DIAGNOSTIC_ACTIONS, TARGETED_DIAGNOSTICS,
  type RouterSummary, type NetworkTotals, type LiveUserCounts, type QueueOverview,
  type WorkerRow, type RouterCapability,
} from '../../../lib/network'
import { cn } from '../../../utils/cn'

/** The states the platform reports, and how each should read. */
const STATE_TONE: Record<string, 'emerald' | 'amber' | 'rose' | 'slate' | 'sky'> = {
  online: 'emerald',
  degraded: 'amber',
  provisioning: 'sky',
  offline: 'rose',
  unreachable: 'rose',
  auth_failed: 'rose',
  config_error: 'rose',
  provisioning_failed: 'rose',
  disabled: 'slate',
  maintenance: 'amber',
}

const STATE_LABEL: Record<string, string> = {
  online: 'ONLINE',
  degraded: 'DEGRADED',
  provisioning: 'PROVISIONING',
  offline: 'OFFLINE',
  unreachable: 'UNREACHABLE',
  auth_failed: 'AUTH FAILED',
  config_error: 'CONFIG ERROR',
  provisioning_failed: 'PROVISIONING FAILED',
  disabled: 'DISABLED',
  maintenance: 'MAINTENANCE',
}

const REACH_LABEL: Record<string, string> = {
  publicly_reachable: 'Publicly reachable',
  nat: 'Behind NAT',
  cgnat: 'CGNAT — tunnel required',
  private_only: 'Private address only',
  vpn_connected: 'VPN tunnel up',
  vpn_not_connected: 'VPN not connected',
  unknown: 'Not determined yet',
}

const METHOD_LABEL: Record<string, string> = {
  api_ssl: 'API over TLS',
  api: 'API (unencrypted)',
  rest: 'HTTPS REST',
  ssh: 'SSH',
  vpn: 'VPN',
  unavailable: 'UNAVAILABLE',
}

function ago(iso: string | null): string {
  if (!iso) return 'never'
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`
  return `${Math.round(secs / 86400)}d ago`
}

function uptime(seconds: number | null): string {
  // Shown in the router detail, where the device has been read and the figure
  // came from the router rather than from a guessed default.
  if (seconds === null) return 'unknown'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  return `${m}m`
}
function ReachIcon({ reachability }: { reachability: string }) {
  // The reachability and the liveness answer different questions, so they get
  // different icons. A router behind CGNAT is not "broken"; it needs a tunnel.
  if (reachability === 'cgnat') return <ShieldAlert size={14} className="text-violet-400" />
  if (reachability === 'nat') return <WifiOff size={14} className="text-amber-400" />
  if (reachability === 'vpn_connected') return <Zap size={14} className="text-emerald-400" />
  if (reachability === 'publicly_reachable') return <Wifi size={14} className="text-emerald-400" />
  return <Plug size={14} className="text-slate-500" />
}

export default function NetworkStatus() {
  const [routers, setRouters] = useState<RouterSummary[]>([])
  const [totals, setTotals] = useState<NetworkTotals | null>(null)
  const [users, setUsers] = useState<LiveUserCounts>({ hotspot: 0, pppoe: 0, total: 0 })
  const [queue, setQueue] = useState<QueueOverview | null>(null)
  const [workers, setWorkers] = useState<WorkerRow[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [overview, q, w] = await Promise.all([
        fetchNetworkOverview(), fetchQueueOverview(), fetchWorkerOverview(),
      ])
      setRouters(overview.routers)
      setTotals(overview.totals)
      setUsers(overview.users)
      setQueue(q)
      setWorkers(w)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    // Polled rather than pushed. The heartbeat that drives these numbers is
    // already on a timer, so matching it keeps the panel honest instead of
    // showing values that change between renders.
    const timer = setInterval(() => void load(), 20_000)
    return () => clearInterval(timer)
  }, [load])

  const poll = async (nodeId: string) => {
    setBusy(nodeId)
    setNotice(null)
    try {
      await requestRouterHeartbeat(nodeId)
      setNotice('Heartbeat requested. The row updates when the worker answers.')
    } catch (err) {
      setNotice(`Could not queue the heartbeat: ${(err as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <Spinner label="Reading router heartbeats and queue state…" />

  const downWorkers = workers.filter((w) => !w.alive)
  const total = totals?.total ?? routers.length

  return (
    <div className="space-y-6">
      {error && (
        <Alert kind="error">{error}</Alert>
      )}

      {downWorkers.length > 0 && (
        <Alert kind="error">
          <strong className="block">No network worker is reporting.</strong>{' '}
          {downWorkers.map((w) => w.name).join(', ')} stopped sending heartbeats. Nothing
          can reach a router until one is back: no polling, no job draining, no
          confirmation that a disconnect reached the device. This is the first thing to
          check when every router looks offline at once.
        </Alert>
      )}

      {notice && <Alert kind="info">{notice}</Alert>}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatTile
          label="Routers online"
          value={`${totals?.online ?? 0} / ${total}`}
          icon={<RadioIcon size={16} />}
          hint={
            total === 0
              ? 'No routers added yet'
              : totals && totals.online === total
                ? 'Every router beat within its threshold'
                : 'Measured from recent heartbeats, not from a status flag'
          }
        />
        <StatTile
          label="Users live"
          value={users.total}
          icon={<Users size={16} />}
          hint={`${users.hotspot} HotSpot · ${users.pppoe} PPPoE`}
        />
        <StatTile
          label="Jobs waiting"
          value={queue?.pending ?? 0}
          icon={<Activity size={16} />}
          hint={
            queue?.oldest_pending_at
              ? `Oldest queued ${ago(queue.oldest_pending_at)}`
              : 'Nothing queued'
          }
        />
        <StatTile
          label="Unreachable routers"
          value={(totals?.behind_nat ?? 0) + (totals?.cgnat ?? 0)}
          icon={<ShieldAlert size={16} />}
          hint={`${totals?.cgnat ?? 0} CGNAT · ${totals?.behind_nat ?? 0} behind NAT`}
        />
        <StatTile
          label="Workers"
          value={`${workers.filter((w) => w.alive).length} / ${workers.length}`}
          icon={<Server size={16} />}
          hint={workers.length === 0 ? 'No worker registered' : 'Sending heartbeats'}
        />
      </div>

      <Card>
        <CardHeader
          title="Routers"
          subtitle="Online means a heartbeat arrived inside the router's own offline threshold. A router row alone never sets it."
          action={
            <Button variant="ghost" size="sm" onClick={() => void load()}>
              <RefreshCw size={14} /> Refresh
            </Button>
          }
        />

        {routers.length === 0 ? (
          <EmptyState
            icon={<RadioIcon size={28} />}
            title="No routers yet"
            hint="Add a router in Routers, then run Provisioning to connect it. Status appears here once the network worker reports a heartbeat."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <Th>Router</Th>
                  <Th>State</Th>
                  <Th>Reachable</Th>
                  <Th>Last beat</Th>
                  <Th>Users</Th>
                  <Th>CPU</Th>
                  <Th>RAM</Th>
                  <Th>Transport</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>{routers.map((r) => (
                <tr
                  key={r.id}
                  className={cn(
                    'border-b border-slate-800/60',
                    selected === r.id && 'bg-slate-800/40',
                  )}
                >
                  <Td>
                    <button
                      type="button"
                      onClick={() => setSelected(selected === r.id ? null : r.id)}
                      className="text-left"
                    >
                      <div className="font-medium text-slate-100">{r.name}</div>
                      <div className="text-xs text-slate-500">
                        {[r.model ?? r.board_name, r.routeros_version, r.architecture]
                          .filter(Boolean).join(' · ') || 'Not surveyed yet'}
                        {r.is_chr && <span className="ml-1 text-violet-400">CHR</span>}
                      </div>
                    </button>
                  </Td>
                  <Td>
                    <Badge
                      value={STATE_LABEL[r.online ? 'online' : r.status] ?? (r.status || 'offline').toUpperCase()}
                      className={STATE_TONE[r.online ? 'online' : r.status] ?? 'slate'}
                    />
                    {r.consecutive_failures > 0 && (
                      <div className="mt-1 text-xs text-rose-400">
                        {r.consecutive_failures} failed in a row
                      </div>
                    )}
                  </Td>
                  <Td>
                    <div className="flex items-center gap-1.5 text-xs text-slate-400">
                      <ReachIcon reachability={r.reachability} />
                      {REACH_LABEL[r.reachability] ?? r.reachability}
                    </div>
                    {r.reachability_note && (
                      <div className="mt-0.5 max-w-[18rem] text-xs text-slate-500">
                        {r.reachability_note}
                      </div>
                    )}
                  </Td>
                  <Td>
                    <div className="flex items-center gap-1.5 text-xs text-slate-400">
                      <Clock size={13} className="text-slate-600" />
                      {ago(r.last_heartbeat_at)}
                    </div>
                  </Td>
                  <Td>{r.active_users}</Td>
                  <Td>
                    {/* A dash, not zero: not measured and measured-as-zero are
                        different facts and the panel must not conflate them. */}
                    {r.cpu_load === null
                      ? <span className="text-slate-600">—</span>
                      : `${r.cpu_load}%`}
                  </Td>
                  <Td>
                    {r.ram_used_mb === null
                      ? <span className="text-slate-600">—</span>
                      : `${r.ram_used_mb} / ${r.ram_total_mb ?? '?'} MB`}
                  </Td>
                  <Td className="text-xs text-slate-400">
                    {METHOD_LABEL[r.last_connection_method ?? ''] ?? r.mgmt_mode ?? '—'}
                  </Td>
                  <Td>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy === r.id}
                      onClick={() => void poll(r.id)}
                    >
                      {busy === r.id ? 'Queued' : 'Poll now'}
                    </Button>
                  </Td>
                </tr>
              ))}</tbody>
            </Table>
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Network workers" subtitle="A worker holds the router sessions. Nothing reaches a router without one." />
          {workers.length === 0 ? (
            <EmptyState
              icon={<Server size={24} />}
              title="No worker registered"
              hint="Deploy the worker from the worker/ directory on a machine with a route to your routers. Until one beats, no router can be polled or changed."
            />
          ) : (
            <div className="space-y-3">
              {workers.map((w) => (
                <div
                  key={w.name}
                  className="flex items-start justify-between gap-3 rounded-lg border border-slate-800 p-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-slate-100">{w.name}</span>
                      <Badge
                        value={w.alive ? 'ALIVE' : 'NOT REPORTING'}
                        className={w.alive ? 'emerald' : 'rose'}
                      />
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {[
                        w.region ?? w.hostname,
                        w.public_ip ? `egress ${w.public_ip}` : null,
                        w.wg_address ? `wg ${w.wg_address}` : null,
                      ].filter(Boolean).join(' · ') || 'No location reported'}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      Beat {ago(w.last_heartbeat_at)} · {w.jobs_processed} done ·{' '}
                      {w.jobs_failed} failed
                    </div>
                    {w.last_error && (
                      <div className="mt-1 flex items-start gap-1 text-xs text-rose-400">
                        <CircleAlert size={12} className="mt-0.5 shrink-0" />
                        {w.last_error}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Job queue" subtitle="Enqueueing is not completion. A job is done only once the router answered." />
          {queue && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {([
                ['Waiting', queue.pending, 'text-slate-200'],
                ['Running', queue.processing, 'text-sky-300'],
                ['Succeeded', queue.succeeded, 'text-emerald-300'],
                ['Failed', queue.failed, 'text-amber-300'],
                ['Dead', queue.dead, 'text-rose-300'],
              ] as const).map(([label, value, tone]) => (
                <div key={label} className="rounded-lg border border-slate-800 p-3">
                  <div className={cn('text-lg font-semibold', tone)}>{value}</div>
                  <div className="text-xs text-slate-500">{label}</div>
                </div>
              ))}
            </div>
          )}
          {queue && queue.dead > 0 && (
            <div className="mt-3 text-xs text-amber-400">
              {queue.dead} job{queue.dead === 1 ? '' : 's'} exhausted every retry. These
              will not run again on their own — inspect the router, fix the cause, and
              retry from the router's job list.
            </div>
          )}
          {queue && queue.processing > 0 && !workers.some((w) => w.alive) && (
            <div className="mt-3 text-xs text-rose-400">
              Jobs are stuck in "running" with no live worker. They will be reclaimed
              when a worker returns, but nothing is progressing right now.
            </div>
          )}
        </Card>
      </div>
      {selected && (
        <RouterDetail
          router={routers.find((r) => r.id === selected)!}
          onClose={() => setSelected(null)}
          onChanged={() => void load()}
        />
      )}
    </div>
  )
}

/** Checks the worker knows about, in the order an ISP reaches for them. */
const FEATURES: Array<{ key: keyof RouterCapability; label: string; needsV7?: string }> = [
  { key: 'has_hotspot', label: 'HotSpot' },
  { key: 'has_pppoe', label: 'PPPoE', needsV7: 'needs RouterOS 7' },
  { key: 'has_wireguard', label: 'WireGuard', needsV7: 'needs RouterOS 7' },
  { key: 'has_bridge', label: 'Bridges' },
  { key: 'has_vlan', label: 'VLAN', needsV7: 'needs RouterOS 7' },
  { key: 'has_dhcp', label: 'DHCP' },
  { key: 'has_queue_simple', label: 'Simple queues' },
  { key: 'has_queue_tree', label: 'Queue tree', needsV7: 'needs RouterOS 7' },
  { key: 'has_radius', label: 'RADIUS' },
  { key: 'has_scheduler', label: 'Scheduler' },
  { key: 'has_scripting', label: 'Scripting' },
]
function RouterDetail({
  router,
  onClose,
  onChanged,
}: {
  router: RouterSummary
  onClose: () => void
  /** Lets a retry here refresh the summary above without closing the panel. */
  onChanged: () => void
}) {
  const [caps, setCaps] = useState<RouterCapability | null>(null)
  const [jobs, setJobs] = useState<Array<{
    id: string; kind: string; status: string; attempt_count: number
    error: string | null; created_at: string; completed_at: string | null
  }>>([])
  const [action, setAction] = useState<string>('identity')
  const [target, setTarget] = useState('')
  const [result, setResult] = useState<{ ok: boolean; output: string; error: string | null } | null>(null)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    void fetchRouterCapabilities(router.id).then(setCaps)
    void fetchRouterJobs(router.id).then(setJobs)
  }, [router.id])

  const run = async () => {
    setRunning(true)
    setResult(null)
    try {
      setResult(await runRouterDiagnostic(router.id, action, target || undefined))
    } catch (err) {
      setResult({ ok: false, output: '', error: (err as Error).message })
    } finally {
      setRunning(false)
    }
  }

  const needsTarget = action === 'ping' || action === 'dns_lookup'

  const SURVEY: Array<[string, string]> = caps ? [
    ['Board', caps.board_name ?? '—'],
    ['Model', caps.model ?? '—'],
    ['RouterOS', caps.routeros_version ?? '—'],
    ['Architecture', caps.architecture ?? '—'],
    ['CPU', [caps.cpu_type, caps.cpu_count ? `${caps.cpu_count}×` : null]
      .filter(Boolean).join(' ') || '—'],
    ['RAM', caps.ram_total_mb ? `${caps.ram_total_mb} MB` : '—'],
    ['Storage', caps.storage_total_mb ? `${caps.storage_total_mb} MB` : '—'],
    ['Uptime', uptime(router.uptime_seconds)],
    ['Licence', caps.license_level ?? '—'],
    ['Detected', `${ago(caps.detected_at)} by ${caps.detected_by}`],
  ] : []

  return (
    <Card>
      <CardHeader
        title={router.name}
        subtitle="What the router reported about itself, and what the worker has done since."
        action={<Button variant="ghost" size="sm" onClick={onClose}>Close</Button>}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Hardware survey
          </h4>
          {!caps ? (
            <p className="text-sm text-slate-500">
              Not surveyed yet. The worker records this on first successful contact;
              until then the panel shows nothing rather than assuming RouterOS 7.
            </p>
          ) : (
            <>
              <dl className="mb-4 grid grid-cols-2 gap-x-4">
                {SURVEY.map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-2 border-b border-slate-800/50 py-1 text-sm">
                    <dt className="text-slate-500">{k}</dt>
                    <dd className="text-right text-slate-300">{v}</dd>
                  </div>
                ))}
              </dl>

              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Features
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {FEATURES.map((f) => {
                  const present = Boolean(caps[f.key])
                  return (
                    <span
                      key={f.label}
                      title={present ? undefined : (f.needsV7 ?? 'not reported by this router')}
                      className={cn(
                        'rounded px-2 py-0.5 text-xs',
                        present
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : 'bg-slate-800 text-slate-500',
                      )}
                    >
                      {f.label}{present ? '' : ' ✕'}
                    </span>
                  )
                })}
              </div>

              {caps.unsupported.length > 0 && (
                <p className="mt-3 text-xs text-amber-400">
                  Not usable on this device: {caps.unsupported.join(', ')}. Options that
                  need them are hidden rather than offered and then failed.
                </p>
              )}
            </>
          )}
        </div>
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Diagnostics
          </h4>
          <div className="flex flex-wrap gap-2">
            <select
              value={action}
              onChange={(e) => setAction(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200"
            >
              {DIAGNOSTIC_ACTIONS.map((a) => (
                <option key={a.value} value={a.value}>{a.label}</option>
              ))}
              {TARGETED_DIAGNOSTICS.map((a) => (
                <option key={a.value} value={a.value}>{a.label}</option>
              ))}
            </select>
            {needsTarget && (
              <input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder={TARGETED_DIAGNOSTICS.find((d) => d.value === action)?.targetLabel ?? 'Target'}
                className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200"
              />
            )}
            <Button size="sm" disabled={running} onClick={() => void run()}>
              {running ? 'Asking the router…' : 'Run'}
            </Button>
          </div>
          <p className="mt-1 text-xs text-slate-600">
            Read-only commands from a fixed list. The worker refuses anything else, so
            this cannot become a way to run arbitrary RouterOS.
          </p>

          {result && (
            <div className="mt-3">
              <div className={cn(
                'mb-1 text-xs font-semibold',
                result.ok ? 'text-emerald-400' : 'text-rose-400',
              )}>
                {result.ok ? 'Router answered' : 'No answer'}
              </div>
              <pre className="max-h-72 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs text-slate-300">
                {result.error ?? result.output}
              </pre>
            </div>
          )}

          <h4 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Recent jobs
          </h4>
          {jobs.length === 0 ? (
            <p className="text-sm text-slate-500">No jobs recorded for this router yet.</p>
          ) : (
            <div className="space-y-1.5">
              {jobs.map((j) => (
                <div
                  key={j.id}
                  className="flex items-start justify-between gap-3 rounded border border-slate-800 px-2.5 py-1.5"
                >
                  <div className="min-w-0">
                    <span className="text-xs font-medium text-slate-300">{j.kind}</span>
                    <span className="ml-2 text-xs text-slate-600">{ago(j.created_at)}</span>
                    {j.error && (
                      <div className="mt-0.5 text-xs text-rose-400">{j.error}</div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {j.attempt_count > 1 && (
                      <span className="text-xs text-slate-600">try {j.attempt_count}</span>
                    )}
                    <Badge value={j.status.toUpperCase()} className={
                      j.status === 'succeeded' ? 'emerald'
                        : j.status === 'dead' ? 'rose'
                          : j.status === 'failed' ? 'amber' : 'sky'
                    } />
                    {j.status === 'dead' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void retryRouterJob(j.id).then(onChanged)}
                      >
                        Retry
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}