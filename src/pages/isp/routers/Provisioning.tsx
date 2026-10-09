/**
 * MikroTik provisioning wizard — driven by the FastAPI provision engine.
 *
 * The engine (backend/) owns everything router-side. This page walks the
 * operator through its 3-step wizard:
 *
 *   1. Bootstrap — enters the router identity, creates the router row +
 *      a create-only session, and shows the one-liner to paste into the
 *      router terminal (Winbox: New Terminal).
 *   2. Device scan — reads the router's interfaces, services and network
 *      config (reported by the bootstrap script itself, so it works behind
 *      NAT), then continues into configuration.
 *   3. Apply & watch — sends the service configuration and polls session
 *      status. Live streaming remains unavailable until authenticated tickets
 *      are implemented by the API.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Plug, Copy, CheckCircle2, RefreshCw, ChevronRight, Terminal,
  Radio, ListChecks, XCircle, Loader2,
} from 'lucide-react'
import {
  Card, CardHeader, Button, Alert, Spinner, Badge, EmptyState, inputClass,
} from '../../../components/ui'
import {
  upsertRouter, createSession, getBootstrapCommand, scanDevice, startWorkflow,
  getSessionStatus, listSessions, cancelActiveSessions,
  waitForScanReport,
  type BackendRouter, type ProvisionSession, type BootstrapCommand,
  type DeviceScan, type ProvisioningServiceType,
} from '../../../lib/provisionApi'
import { cn } from '../../../utils/cn'

interface LogLine {
  time: string
  level: string
  message: string
}

const now = () => new Date().toLocaleTimeString()

const STATUS_TONE: Record<string, string> = {
  completed: 'emerald',
  in_progress: 'amber',
  pending: 'sky',
  failed: 'rose',
  cancelled: 'slate',
  timeout: 'rose',
}

const SERVICE_TYPE: ProvisioningServiceType = 'hotspot'
const DEFAULT_ROUTER_IP = '192.168.88.1'
const DEFAULT_API_PORT = 8728
const DEFAULT_WAN_INTERFACE = 'ether1'

function lineLevel(level: string): string {
  switch (level) {
    case 'success': return 'text-emerald-300'
    case 'error': return 'text-rose-300'
    case 'warning': return 'text-amber-300'
    default: return 'text-slate-300'
  }
}

/* ── Session history ─────────────────────────────────────────────────────── */

function SessionsList({
  sessions, busy, onRefresh,
}: {
  sessions: ProvisionSession[]
  busy: boolean
  onRefresh: () => void
}) {
  return (
    <Card>
      <div className="flex items-center justify-between px-5 pt-4">
        <h2 className="text-sm font-black text-slate-900 dark:text-white flex items-center gap-2">
          <ListChecks className="w-4 h-4" /> Provisioning sessions
        </h2>
        <Button size="sm" variant="secondary" onClick={onRefresh} disabled={busy}
          icon={<RefreshCw className={cn('w-3.5 h-3.5', busy && 'animate-spin')} />}>
          Refresh
        </Button>
      </div>
      <div className="p-5 pt-3">
        {sessions.length === 0 ? (
          <EmptyState icon={<Radio className="w-10 h-10" />} title="No sessions yet"
            hint="Generate a bootstrap command below to start your first run." />
        ) : (
          <div className="space-y-2">
            {sessions.map((s) => (
              <div key={s.session_id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 dark:border-slate-700 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-[11px] font-mono text-slate-500 truncate">{s.session_id}</p>
                  <p className="text-[11px] text-slate-500">
                    router #{s.router_id}
                    {s.service_type ? ` · ${s.service_type}` : ''}
                    {s.created_at ? ` · ${new Date(s.created_at).toLocaleString()}` : ''}
                  </p>
                </div>
                <Badge value={STATUS_TONE[s.status] ?? 'slate'} />
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  )
}

/* ── Live log pane ───────────────────────────────────────────────────────── */

function LogPane({ logs }: { logs: LogLine[] }) {
  return (
    <div className="rounded-xl bg-slate-900 p-4 h-64 overflow-y-auto font-mono text-[11px] leading-relaxed">
      {logs.length === 0 ? (
        <p className="text-slate-500">Waiting for engine events… run the bootstrap command on the router, then watch this pane.</p>
      ) : logs.map((l, i) => (
        <p key={i} className={lineLevel(l.level)}>
          <span className="text-slate-500">{l.time}</span> {l.message}
        </p>
      ))}
    </div>
  )
}

/* ── Main wizard page ────────────────────────────────────────────────────── */

export function ProvisioningPage() {
  const [sessions, setSessions] = useState<ProvisionSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Step 1 - router details
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [identity, setIdentity] = useState('')
  const [wanIface, setWanIface] = useState(DEFAULT_WAN_INTERFACE)

  // Created records
  const [router, setRouter] = useState<BackendRouter | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [bootstrap, setBootstrap] = useState<BootstrapCommand | null>(null)

  // Step 2 - scanned device
  const [scan, setScan] = useState<DeviceScan | null>(null)
  const [cfg, setCfg] = useState({
    subnet_address: '172.31.0.0',
    cidr: '16',
    gateway: '',
    ip_pool_start: '',
    ip_pool_end: '',
    dns_servers: '8.8.8.8,8.8.4.4',
    bridge_ports: 'ether2',
  })

  // Step 3 - live run
  const [logs, setLogs] = useState<LogLine[]>([])
  const [runStatus, setRunStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pollRef = useRef<number | null>(null)

  const pushLog = useCallback((level: string, message: string) => {
    setLogs((prev) => [...prev.slice(-299), { time: now(), level, message }])
  }, [])

  const stopStream = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await listSessions())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load sessions.')
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    void refreshSessions().finally(() => setLoading(false))
    return () => stopStream()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Poll GET /sessions/{id}/status until the workflow reaches a terminal state. */
  const pollStatus = useCallback((sid: string) => {
    if (pollRef.current !== null) window.clearInterval(pollRef.current)
    const tick = async () => {
      try {
        const st = await getSessionStatus(sid)
        setRunStatus(st.status)
        if (st.status === 'completed') {
          pushLog('success', 'Provisioning completed successfully.')
          if (pollRef.current !== null) {
            window.clearInterval(pollRef.current)
            pollRef.current = null
          }
          void refreshSessions()
        } else if (st.status === 'failed') {
          pushLog('error', st.error_message ?? 'Provisioning failed.')
          if (pollRef.current !== null) {
            window.clearInterval(pollRef.current)
            pollRef.current = null
          }
          void refreshSessions()
        }
      } catch (e) {
        pushLog('warning', e instanceof Error ? e.message : 'Status poll failed.')
      }
    }
    void tick()
    pollRef.current = window.setInterval(() => void tick(), 3000)
  }, [pushLog, refreshSessions])

  /* ── Step 1: router + session + bootstrap command ── */

  async function generate() {
    setBusy(true); setError(null)
    try {
      const r = await upsertRouter({
        name: identity.trim(),
        ip_address: DEFAULT_ROUTER_IP,
        api_port: DEFAULT_API_PORT,
      })
      setRouter(r)

      const s = await createSession(r.id, SERVICE_TYPE, {
        identity: r.name,
        subnet_address: cfg.subnet_address,
        cidr: Number(cfg.cidr) || 16,
      })
      setSessionId(s.session_id)

      const b = await getBootstrapCommand({
        identity: r.name,
        api_port: r.port,
        interface: wanIface,
        ip_address: r.ip_address,
        session_id: s.session_id,
        router_id: r.id,
      })
      setBootstrap(b)
      setLogs([])
      setRunStatus(null)
      setStep(2)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not generate the bootstrap command.')
    } finally {
      setBusy(false)
    }
  }

  /* ── Step 2: device scan ── */

  async function runScan(force = false) {
    if (!router) return
    setBusy(true); setError(null)
    try {
      const s = force
        // Deliberate direct dial — the operator asked to bypass the cache.
        ? await scanDevice(router.id, true)
        // Default: wait for the bootstrap script's phone-home report
        // (DB-only probe poll + optimistic cache read). Never dials the
        // router, so it cannot stall behind NAT; shows progress meanwhile.
        : await waitForScanReport(router.id, {
            onProgress: (secs) => pushLog(
              'info',
              `Waiting for the router's scan report (${secs}s) — paste the bootstrap command on the router if you have not yet.`,
            ),
          })
      setScan(s)
      const n = s.network_config
      setCfg((prev) => ({
        ...prev,
        subnet_address: n.network_address && n.cidr
          ? n.network_address
          : prev.subnet_address,
        cidr: String(n.cidr || prev.cidr),
        gateway: n.gateway || prev.gateway,
        ip_pool_start: n.dhcp_start || prev.ip_pool_start,
        ip_pool_end: n.dhcp_end || prev.ip_pool_end,
        bridge_ports: s.interfaces.filter((i) => i !== s.wan_interface).join(', ') || prev.bridge_ports,
      }))
      setWanIface(s.wan_interface || wanIface)
      pushLog('success', `Scan complete: ${s.interfaces.length} interface(s), RouterOS ${s.system_info.version || '?'}.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Device scan failed.')
      pushLog('warning', 'Device scan failed — fill the configuration in manually and continue.')
    } finally {
      setBusy(false)
    }
  }

  /* ── Step 3: apply configuration ── */

  /** Configuration dict the engine's command generator understands. */
  function buildConfiguration(): Record<string, unknown> {
    const ports = cfg.bridge_ports.split(',').map((p) => p.trim()).filter(Boolean)
    return {
      identity: router?.name,
      subnet_address: cfg.subnet_address,
      cidr: Number(cfg.cidr) || 16,
      gateway: cfg.gateway || undefined,
      ip_pool_start: cfg.ip_pool_start || undefined,
      ip_pool_end: cfg.ip_pool_end || undefined,
      dns_servers: cfg.dns_servers.split(',').map((d) => d.trim()).filter(Boolean),
      bridge_ports: ports,
      wan_interface: wanIface,
    }
  }

  async function apply() {
    if (!router) return
    setBusy(true); setError(null)
    try {
      // The create-only session from step 1 is still PENDING; the engine
      // refuses a new workflow while it is active, so clear it first.
      await cancelActiveSessions(router.id)
      const w = await startWorkflow(router.id, SERVICE_TYPE, buildConfiguration())
      pushLog('info', w.message)
      pushLog('info', 'Tracking progress with authenticated status polling.')
      pollStatus(w.session_id)
      setStep(3)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not start provisioning.'
      setError(msg)
      pushLog('error', msg)
    } finally {
      setBusy(false)
    }
  }

  /* ── render ── */

  const stepper = (
    <div className="flex items-center gap-2 text-[11px] font-bold">
      {(['Bootstrap', 'Device scan', 'Apply & watch'] as const).map((label, i) => (
        <span key={label} className="flex items-center gap-2">
          {i > 0 && <ChevronRight className="w-3.5 h-3.5 text-slate-300" />}
          <span className={cn(
            'rounded-full px-3 py-1',
            step === i + 1
              ? 'bg-violet-600 text-white'
              : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
          )}>
            {i + 1}. {label}
          </span>
        </span>
      ))}
    </div>
  )

  const field = (label: string, node: React.ReactNode) => (
    <label className="block">
      <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300">{label}</span>
      {node}
    </label>
  )

  if (loading) return <Spinner label="Loading provisioning sessions..." />

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-start gap-3">
          <Plug className="w-5 h-5 text-violet-600 dark:text-violet-400 mt-0.5" />
          <div>
            <h1 className="text-xl font-black tracking-tight text-slate-900 dark:text-white">
              Add a MikroTik
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              One command. The router tells us what it is.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => {
            stopStream()
            setStep(1); setBootstrap(null); setScan(null); setSessionId(null)
            setRouter(null); setLogs([]); setRunStatus(null); setError(null)
          }} icon={<Plug className="w-3.5 h-3.5" />}>
            + ADD MIKROTIK
          </Button>
        </div>
      </div>

      {error && <Alert kind="error">{error}</Alert>}

      <Card>
        <CardHeader title="Provisioning wizard" icon={<Terminal className="w-4 h-4" />} />
        <div className="p-5 space-y-4">
          {stepper}

          {step === 1 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {field('Router identity', (
                <input className={cn(inputClass, 'mt-1')} value={identity}
                  onChange={(e) => setIdentity(e.target.value)} placeholder="e.g. Office Router"
                  autoComplete="off" maxLength={64} required />
              ))}
              <div className="sm:col-span-2">
                <Alert kind="info">
                  Enter the router name only. The wizard uses RouterOS defaults for
                  first contact, then discovers the router interfaces and network
                  automatically. The session id is embedded in the callback URL.
                </Alert>
              </div>
              <div className="sm:col-span-2 flex justify-end">
                <Button onClick={() => void generate()} disabled={busy || !identity.trim()}
                  icon={<ChevronRight className="w-3.5 h-3.5" />}>
                  {busy ? 'Generating...' : 'Generate bootstrap command'}
                </Button>
              </div>
            </div>
          )}

          {step >= 2 && bootstrap && (
            <div className="space-y-3">
              <p className="text-xs text-slate-600 dark:text-slate-300">
                Open the router terminal (Winbox: <span className="font-mono">New Terminal</span>)
                and paste these lines.
                {sessionId && (
                  <> Session <span className="font-mono">{sessionId.slice(0, 8)}…</span>.</>
                )}
              </p>
              <pre className="rounded-xl bg-slate-900 p-4 text-[11px] font-mono text-emerald-300 overflow-x-auto whitespace-pre-wrap">
                {bootstrap.command}
              </pre>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" icon={<Copy className="w-3.5 h-3.5" />}
                  onClick={() => void navigator.clipboard.writeText(bootstrap.command)}>
                  Copy command
                </Button>
                <Button size="sm" variant="secondary"
                  onClick={() => void runScan(false)} disabled={busy}>
                  Scan device
                </Button>
                <Button size="sm" variant="secondary"
                  onClick={() => void runScan(true)} disabled={busy}>
                  Force re-scan
                </Button>
              </div>
              {bootstrap.bootstrap_already_done && (
                <Alert kind="info">
                  This router already completed bootstrap and has stored API credentials —
                  you can scan and apply straight away.
                </Alert>
              )}
              {router && bootstrap.ping_check && !bootstrap.ping_check.reachable && (
                <Alert kind="error">
                  Device not responding to ping/check at {router.ip_address}. Check the network connection,
                  then run the bootstrap command on the router anyway — its callback reaches the
                  engine even from behind NAT.
                </Alert>
              )}
              {bootstrap.notes.length > 0 && (
                <ul className="text-[11px] text-slate-500 space-y-1">
                  {bootstrap.notes.map((n, i) => <li key={i}>• {n}</li>)}
                </ul>
              )}
            </div>
          )}

          {step >= 2 && scan && (
            <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-2">
              <p className="text-[11px] font-black text-slate-700 dark:text-slate-200">
                Scanned: {scan.system_info.identity || scan.system_info.board_name || 'device'}
                {scan.system_info.version ? ` · RouterOS ${scan.system_info.version}` : ''}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {scan.interfaces.map((i) => (
                  <span key={i} className={cn(
                    'rounded-full px-2 py-0.5 font-mono text-[10px]',
                    i === scan.wan_interface
                      ? 'bg-sky-100 text-sky-700 dark:bg-sky-900 dark:text-sky-200'
                      : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
                  )}>
                    {i}{i === scan.wan_interface ? ' (WAN)' : ''}
                  </span>
                ))}
              </div>
              <div className="grid gap-3 sm:grid-cols-3 pt-1">
                {field('Subnet', (
                  <input className={cn(inputClass, 'mt-1')} value={cfg.subnet_address}
                    onChange={(e) => setCfg({ ...cfg, subnet_address: e.target.value })} />
                ))}
                {field('CIDR', (
                  <input className={cn(inputClass, 'mt-1')} value={cfg.cidr}
                    onChange={(e) => setCfg({ ...cfg, cidr: e.target.value })} />
                ))}
                {field('Gateway', (
                  <input className={cn(inputClass, 'mt-1')} value={cfg.gateway}
                    onChange={(e) => setCfg({ ...cfg, gateway: e.target.value })} />
                ))}
                {field('Pool start', (
                  <input className={cn(inputClass, 'mt-1')} value={cfg.ip_pool_start}
                    onChange={(e) => setCfg({ ...cfg, ip_pool_start: e.target.value })} />
                ))}
                {field('Pool end', (
                  <input className={cn(inputClass, 'mt-1')} value={cfg.ip_pool_end}
                    onChange={(e) => setCfg({ ...cfg, ip_pool_end: e.target.value })} />
                ))}
                {field('DNS servers (comma separated)', (
                  <input className={cn(inputClass, 'mt-1')} value={cfg.dns_servers}
                    onChange={(e) => setCfg({ ...cfg, dns_servers: e.target.value })} />
                ))}
                {field('Bridge ports (comma separated)', (
                  <input className={cn(inputClass, 'mt-1')} value={cfg.bridge_ports}
                    onChange={(e) => setCfg({ ...cfg, bridge_ports: e.target.value })} />
                ))}
                {field('WAN interface', (
                  <input className={cn(inputClass, 'mt-1')} value={wanIface}
                    onChange={(e) => setWanIface(e.target.value)} />
                ))}
                <div className="sm:col-span-1" />
              </div>
              {step === 2 && (
                <div className="flex justify-end">
                  <Button onClick={() => void apply()} disabled={busy}
                    icon={<ChevronRight className="w-3.5 h-3.5" />}>
                    {busy ? 'Starting...' : 'Apply configuration'}
                  </Button>
                </div>
              )}
            </div>
          )}

          {step === 3 && runStatus === 'completed' && (
            <Alert kind="success">
              <span className="flex items-start gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-px" />
                Provisioning completed. The router is configured and the polling agent
                is installed — subscriptions will reach it even behind NAT.
              </span>
            </Alert>
          )}
          {step === 3 && runStatus === 'failed' && (
            <Alert kind="error">
              <span className="flex items-start gap-1.5">
                <XCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
                Provisioning failed. Read the log below, fix the cause on the router,
                then apply again.
              </span>
            </Alert>
          )}
          {step === 3 && runStatus !== 'completed' && (
            <p className="text-[11px] text-slate-500 flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {runStatus === 'failed' ? 'Provisioning failed.' : 'Provisioning running…'}
            </p>
          )}

          {step >= 2 && <LogPane logs={logs} />}
        </div>
      </Card>

      <SessionsList sessions={sessions} busy={loading} onRefresh={() => void refreshSessions()} />
    </div>
  )
}
