/**
 * MikroTik provisioning wizard — driven by the FastAPI provision engine.
 *
 * The engine (backend/) owns everything router-side. This page walks the
 * operator through the full provisioning workflow:
 *
 *   1. Identity   — router display name (also the engine's router identity).
 *   2. Bootstrap  — the public POST /bootstrap call returns the one-liner to
 *                   paste into the router terminal (Winbox: New Terminal).
 *   3. Discovery  — waits for the scan the bootstrap script phones home
 *                   (works behind NAT; never dials the router directly).
 *   4. Interfaces — review the device's REAL interfaces and confirm WAN,
 *                   HotSpot LAN and PPPoE assignments.
 *   5. Services   — HotSpot / PPPoE / Both plus the network plan, prefilled
 *                   from the scan's network config.
 *   6. Review     — exactly what will be applied, before anything runs.
 *   7. Deploy     — starts the workflow and renders the engine's REAL step
 *                   log and status (no simulated progress).
 *   8. Verify     — reads the router row back (bootstrap completed, scan
 *                   stored, agent installed, agent checked in). States are
 *                   only green when the backend reports them green.
 *
 * EVERY call in this wizard is public and unauthenticated — matching the
 * backend endpoints ("public, no auth required" / "auth disabled"). No
 * sign-in is ever required to provision a router.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Plug, Copy, CheckCircle2, RefreshCw, ChevronRight, ChevronLeft, Terminal,
  Radio, ListChecks, XCircle, Loader2,
} from 'lucide-react'
import {
  Card, CardHeader, Button, Alert, Spinner, Badge, EmptyState, inputClass,
} from '../../../components/ui'
import {
  generateBootstrapCommand, fetchProvisioningSessions,
  waitForScanReport, cancelActiveSessions, startProvisioningWorkflow,
  fetchProvisioningSessionStatus, getDirectApiStatus,
  type PublicProvisionSession, type DeviceScan, type DirectApiStatus,
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
  scanned: 'sky',
  in_progress: 'amber',
  pending: 'sky',
  failed: 'rose',
  cancelled: 'slate',
  timeout: 'rose',
}

const DEFAULT_WAN_INTERFACE = 'ether1'

/** Same rule the backend enforces (bootstrap.py identity regex). */
const IDENTITY_RE = /^[A-Za-z0-9][A-Za-z0-9_. -]{0,63}$/

const STEPS = [
  'Identity', 'Bootstrap', 'Discovery', 'Interfaces',
  'Services', 'Review', 'Deploy', 'Verify',
] as const
type StepNum = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

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
  sessions: PublicProvisionSession[]
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
            hint="Start with the Identity step above to provision your first router." />
        ) : (
          <div className="space-y-2">
            {sessions.map((s) => (
              <div key={s.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 dark:border-slate-700 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-[11px] font-mono text-slate-500 truncate">{s.id}</p>
                  <p className="text-[11px] text-slate-500">
                    {s.identity || 'Router'}
                    {s.wan_interface ? ` · ${s.wan_interface}` : ''}
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
    <div className="rounded-xl bg-slate-900 p-4 h-56 overflow-y-auto font-mono text-[11px] leading-relaxed">
      {logs.length === 0 ? (
        <p className="text-slate-500">Events appear here as the engine reports them — nothing is simulated.</p>
      ) : logs.map((l, i) => (
        <p key={i} className={lineLevel(l.level)}>
          <span className="text-slate-500">{l.time}</span> {l.message}
        </p>
      ))}
    </div>
  )
}

/* ── Small presentational helpers ────────────────────────────────────────── */

function StepPill({
  index, label, active, reachable, onClick,
}: {
  index: number
  label: string
  active: boolean
  reachable: boolean
  onClick: () => void
}) {
  return (
    <span className="flex items-center gap-2">
      <button
        onClick={reachable ? onClick : undefined}
        disabled={!reachable}
        className={cn(
          'rounded-full px-3 py-1 flex items-center gap-1 outline-none text-[11px] font-bold',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          active
            ? 'bg-violet-600 text-white'
            : reachable
              ? 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
              : 'bg-slate-200 text-slate-400 dark:bg-slate-800 dark:text-slate-600',
        )}>
        {index}. {label}
      </button>
    </span>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2 text-xs">
      <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide min-w-[9rem]">{label}</span>
      <span className="text-slate-800 dark:text-slate-200 font-mono break-all">{children}</span>
    </div>
  )
}

/** One real verification fact: only green when the backend says so. */
function VerifyRow({ label, ok, pending, detail }: {
  label: string
  ok: boolean | null
  pending?: string
  detail?: string
}) {
  return (
    <div className="flex items-start gap-2 text-xs">
      {ok === null ? (
        <Loader2 className="w-3.5 h-3.5 text-slate-400 animate-spin shrink-0 mt-px" />
      ) : ok ? (
        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-px" />
      ) : (
        <XCircle className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-px" />
      )}
      <div>
        <span className="text-slate-800 dark:text-slate-200">{label}</span>
        {ok === false && pending && (
          <span className="block text-[11px] text-amber-600 dark:text-amber-400">{pending}</span>
        )}
        {detail && <span className="block text-[11px] text-slate-500">{detail}</span>}
      </div>
    </div>
  )
}

/* ── Main wizard page ────────────────────────────────────────────────────── */

export function ProvisioningPage() {
  const [sessions, setSessions] = useState<PublicProvisionSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Wizard position
  const [step, setStep] = useState<StepNum>(1)

  // 1. Identity
  const [identity, setIdentity] = useState('')
  const [wanIface, setWanIface] = useState(DEFAULT_WAN_INTERFACE)

  // 2. Bootstrap
  const [routerId, setRouterId] = useState<number | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [bootstrapCommand, setBootstrapCommand] = useState<string | null>(null)

  // 3. Discovery
  const [scan, setScan] = useState<DeviceScan | null>(null)
  const [discovering, setDiscovering] = useState(false)

  // 4. Interfaces
  const [hotspotIface, setHotspotIface] = useState('')
  const [pppoeIface, setPppoeIface] = useState('')

  // 5. Services
  const [serviceMode, setServiceMode] = useState<'hotspot' | 'pppoe' | 'both'>('hotspot')
  const [cfg, setCfg] = useState({
    subnet_address: '172.31.0.0',
    cidr: '16',
    gateway: '',
    ip_pool_start: '',
    ip_pool_end: '',
    dns_servers: '8.8.8.8,8.8.4.4',
    bridge_ports: 'ether2',
  })

  // 7. Deploy — engine-reported state only
  const [logs, setLogs] = useState<LogLine[]>([])
  const [runStatus, setRunStatus] = useState<string | null>(null)
  const [wfSteps, setWfSteps] = useState<Array<Record<string, unknown>> | null>(null)
  const [busy, setBusy] = useState(false)
  const pollRef = useRef<number | null>(null)

  // 8. Verify
  const [direct, setDirect] = useState<DirectApiStatus | null>(null)
  const [verifying, setVerifying] = useState(false)

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
      setSessions(await fetchProvisioningSessions())
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

  /* ── 1→2: create the router row + session + one-liner ─────────────────── */

  async function generate() {
    const name = identity.trim()
    if (!IDENTITY_RE.test(name)) {
      setError('Use 1–64 characters: letters, digits, spaces, dots, dashes or underscores (must start with a letter or digit).')
      return
    }
    setBusy(true); setError(null)
    try {
      const res = await generateBootstrapCommand({
        identity: name,
        wan_interface: wanIface.trim() || DEFAULT_WAN_INTERFACE,
      })
      setSessionId(res.session_id)
      setRouterId(res.router_id ?? null)
      setBootstrapCommand(res.bootstrap_command)
      setScan(null); setLogs([]); setRunStatus(null); setWfSteps(null); setDirect(null)
      setStep(2)
      void refreshSessions()
      pushLog('info', `Bootstrap session ${res.session_id.slice(0, 8)}… created for "${name}".`)
      // Start waiting for the router's phone-home scan immediately; the
      // operator pastes the command on the Discovery screen while it waits.
      if (res.router_id != null) void watchScan(res.router_id)
      else void watchSessionForRouter(res.session_id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not generate the bootstrap command.')
    } finally {
      setBusy(false)
    }
  }

  /** Edge case: bootstrap response without router_id — resolve it from the
   *  session status, then wait for the scan as usual. */
  function watchSessionForRouter(sid: string) {
    stopStream()
    const tick = async () => {
      try {
        const st = await fetchProvisioningSessionStatus(sid)
        if (st.router_id != null) {
          stopStream()
          setRouterId(st.router_id)
          void watchScan(st.router_id)
        }
      } catch (e) {
        pushLog('warning', e instanceof Error ? e.message : 'Session status poll failed.')
      }
    }
    void tick()
    pollRef.current = window.setInterval(() => void tick(), 2000)
  }

  /* ── 3: wait for the router's scan report (DB-only, NAT-safe) ─────────── */

  async function watchScan(rid: number) {
    setDiscovering(true)
    setStep((s) => (s === 1 || s === 2 ? 3 : s))
    try {
      const s = await waitForScanReport(rid, {
        onProgress: (secs) => pushLog(
          'info',
          `Waiting for the router's scan report (${secs}s) — paste the bootstrap one-liner in the router terminal (Winbox: New Terminal) if you have not yet.`,
        ),
      })
      applyScan(s)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Device scan failed.'
      setError(msg)
      pushLog('warning', msg)
    } finally {
      setDiscovering(false)
    }
  }

  /** Store the REAL scan and prefill every later step from it. */
  function applyScan(s: DeviceScan) {
    setScan(s)
    stopStream()
    const others = s.interfaces.filter((i) => i !== s.wan_interface)
    setWanIface(s.wan_interface || wanIface)
    setHotspotIface((prev) => prev || others.find((i) => /^ether/.test(i)) || others[0] || '')
    setPppoeIface((prev) => prev || others.filter((i) => /^ether/.test(i))[1] || others[1] || '')
    const n = s.network_config
    setCfg((prev) => ({
      ...prev,
      subnet_address: n.network_address && n.cidr ? n.network_address : prev.subnet_address,
      cidr: String(n.cidr || prev.cidr),
      gateway: n.gateway || prev.gateway,
      ip_pool_start: n.dhcp_start || prev.ip_pool_start,
      ip_pool_end: n.dhcp_end || prev.ip_pool_end,
      dns_servers: n.dns_servers?.length ? n.dns_servers.join(',') : prev.dns_servers,
      bridge_ports: others.join(', ') || prev.bridge_ports,
    }))
    pushLog('success', `Scan complete: ${s.interfaces.length} interface(s), RouterOS ${s.system_info.version || '?'}${s.system_info.board_name ? ` on ${s.system_info.board_name}` : ''}.`)
    setStep((cur) => (cur <= 3 ? 4 : cur))
  }

  /* ── 6→7: deploy via the engine, then poll its REAL status ────────────── */

  /** Configuration dict the engine's command generator understands. */
  function buildConfiguration(): Record<string, unknown> {
    const ports = cfg.bridge_ports.split(',').map((p) => p.trim()).filter(Boolean)
    return {
      identity: identity.trim(),
      subnet_address: cfg.subnet_address,
      cidr: Number(cfg.cidr) || 16,
      gateway: cfg.gateway || undefined,
      ip_pool_start: cfg.ip_pool_start || undefined,
      ip_pool_end: cfg.ip_pool_end || undefined,
      dns_servers: cfg.dns_servers.split(',').map((d) => d.trim()).filter(Boolean),
      bridge_ports: ports,
      wan_interface: wanIface,
      ...(serviceMode !== 'pppoe' && hotspotIface ? { hotspot_interface: hotspotIface } : {}),
      ...(serviceMode !== 'hotspot' && pppoeIface ? { pppoe_interface: pppoeIface } : {}),
    }
  }

  async function deploy() {
    if (routerId === null) return
    setBusy(true); setError(null)
    try {
      // The bootstrap session is still PENDING; the engine refuses a new
      // workflow while it is active, so clear it first (public endpoint).
      const cleared = await cancelActiveSessions(routerId)
      if (cleared.cancelled_count > 0) {
        pushLog('info', `Cleared ${cleared.cancelled_count} stale session(s) before deploying.`)
      }
      const w = await startProvisioningWorkflow({
        router_id: routerId,
        service_type: serviceMode === 'pppoe' ? 'pppoe_server' : serviceMode,
        configuration: buildConfiguration(),
      })
      setRunStatus('in_progress')
      setWfSteps(null)
      setStep(7)
      pushLog('info', w.message)
      pollWorkflow(w.session_id)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not start provisioning.'
      setError(msg)
      pushLog('error', msg)
    } finally {
      setBusy(false)
    }
  }

  /** Poll GET /sessions/{id}/status; render ONLY what the engine reports. */
  function pollWorkflow(sid: string) {
    stopStream()
    let lastStatus: string | null = null
    const tick = async () => {
      try {
        const st = await fetchProvisioningSessionStatus(sid)
        setRunStatus(st.status)
        if (st.steps) setWfSteps(st.steps)
        if (st.status !== lastStatus) {
          lastStatus = st.status
          pushLog(
            st.status === 'completed' ? 'success' : st.status === 'failed' ? 'error' : 'info',
            `Workflow ${st.status}${st.current_step ? ` (step: ${st.current_step})` : ''}.`,
          )
        }
        if (st.status === 'completed') {
          stopStream()
          void refreshSessions()
          void runVerify()
        } else if (st.status === 'failed' || st.status === 'cancelled' || st.status === 'timeout') {
          stopStream()
          if (st.error_message) pushLog('error', st.error_message)
          void refreshSessions()
        }
      } catch (e) {
        pushLog('warning', e instanceof Error ? e.message : 'Status poll failed.')
      }
    }
    void tick()
    pollRef.current = window.setInterval(() => void tick(), 3000)
  }

  /* ── 8: verify from the router row — real states only ─────────────────── */

  async function runVerify() {
    if (routerId === null) return
    setVerifying(true)
    try {
      const d = await getDirectApiStatus(routerId)
      setDirect(d)
      pushLog(
        d.agent_online ? 'success' : 'info',
        `Verification: bootstrap=${d.bootstrap_completed ? 'done' : 'pending'}, agent=${d.agent_installed ? 'installed' : 'missing'}, check-in=${d.agent_online ? 'online' : 'offline'}.`,
      )
    } catch (e) {
      pushLog('warning', e instanceof Error ? e.message : 'Verification read failed.')
    } finally {
      setVerifying(false)
    }
  }

  /* ── render ───────────────────────────────────────────────────────────── */

  // Which steps the operator may jump to right now.
  const reachable: Record<StepNum, boolean> = {
    1: true,
    2: bootstrapCommand !== null,
    3: bootstrapCommand !== null,
    4: scan !== null,
    5: scan !== null,
    6: scan !== null,
    7: scan !== null,
    8: runStatus !== null || scan !== null,
  }

  function reset() {
    stopStream()
    setStep(1); setIdentity(''); setWanIface(DEFAULT_WAN_INTERFACE)
    setBootstrapCommand(null); setScan(null); setSessionId(null); setRouterId(null)
    setLogs([]); setRunStatus(null); setWfSteps(null); setDirect(null)
    setHotspotIface(''); setPppoeIface(''); setServiceMode('hotspot')
    setCfg({
      subnet_address: '172.31.0.0', cidr: '16', gateway: '',
      ip_pool_start: '', ip_pool_end: '', dns_servers: '8.8.8.8,8.8.4.4', bridge_ports: 'ether2',
    })
    setError(null)
  }

  const field = (label: string, node: ReactNode) => (
    <label className="block">
      <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300">{label}</span>
      {node}
    </label>
  )

  const stepper = (
    <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold">
      {STEPS.map((label, i) => {
        const stepNum = (i + 1) as StepNum
        return (
          <span key={label} className="flex items-center gap-2">
            {i > 0 && <ChevronRight className="w-3.5 h-3.5 text-slate-300" />}
            <StepPill index={stepNum} label={label} active={step === stepNum}
              reachable={reachable[stepNum]} onClick={() => setStep(stepNum)} />
          </span>
        )
      })}
    </div>
  )

  if (loading) return <Spinner label="Loading provisioning sessions..." />

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-start gap-3">
          <Plug className="w-5 h-5 text-violet-600 dark:text-violet-400 mt-0.5" />
          <div>
            <h1 className="text-xl font-black tracking-tight text-slate-900 dark:text-white">
              Provision a MikroTik
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Name it, discover it, choose services, review, deploy — and watch real verification.
            </p>
          </div>
        </div>
        <Button size="sm" variant="secondary" onClick={reset}
          icon={<RefreshCw className="w-3.5 h-3.5" />}>
          START OVER
        </Button>
      </div>

      {error && <Alert kind="error">{error}</Alert>}

      <Card>
        <CardHeader title="Provisioning wizard" icon={<Terminal className="w-4 h-4" />}
          subtitle={routerId !== null ? `Router #${routerId}${sessionId ? ` · session ${sessionId.slice(0, 8)}…` : ''}` : undefined} />
        <div className="p-5 space-y-4">
          {stepper}

          {/* ── 1. Identity ─────────────────────────────────────────────── */}
          {step === 1 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {field('Router display name', (
                <input className={cn(inputClass, 'mt-1')} value={identity}
                  onChange={(e) => setIdentity(e.target.value)}
                  placeholder="e.g. Office Router"
                  autoComplete="off" maxLength={64} required />
              ))}
              {field('WAN interface', (
                <input className={cn(inputClass, 'mt-1')} value={wanIface}
                  onChange={(e) => setWanIface(e.target.value)}
                  placeholder={DEFAULT_WAN_INTERFACE} autoComplete="off" />
              ))}
              <p className="sm:col-span-2 text-[11px] text-slate-500 dark:text-slate-400">
                The display name becomes the router's identity in the engine. Discovery corrects the
                WAN interface from the router's own scan if it differs.
              </p>
              <div className="sm:col-span-2 flex justify-end">
                <Button onClick={() => void generate()} disabled={busy || !identity.trim()}
                  icon={<ChevronRight className="w-3.5 h-3.5" />}>
                  {busy ? 'Creating session…' : 'Create session & bootstrap command'}
                </Button>
              </div>
            </div>
          )}

          {/* ── 2. Bootstrap ────────────────────────────────────────────── */}
          {step === 2 && bootstrapCommand && (
            <div className="space-y-3">
              <p className="text-xs text-slate-600 dark:text-slate-300">
                Open the router terminal (Winbox: <span className="font-mono">New Terminal</span>)
                and paste this one-liner. It installs the polling agent and phones the scan back here.
              </p>
              <pre className="rounded-xl bg-slate-900 p-4 text-[11px] font-mono text-emerald-300 overflow-x-auto whitespace-pre-wrap">
                {bootstrapCommand}
              </pre>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" icon={<Copy className="w-3.5 h-3.5" />}
                  onClick={() => void navigator.clipboard.writeText(bootstrapCommand)}>
                  Copy command
                </Button>
                <Button size="sm" onClick={() => {
                  setStep(3)
                  if (routerId !== null && !discovering && !scan) void watchScan(routerId)
                }} icon={<ChevronRight className="w-3.5 h-3.5" />}>
                  Continue to discovery
                </Button>
              </div>
              <Alert kind="info">
                The wizard reads the scan the router sends back when it runs this command, so it
                also works behind NAT — no direct connection to the router is needed.
              </Alert>
            </div>
          )}

          {/* ── 3. Discovery ────────────────────────────────────────────── */}
          {step === 3 && (
            <div className="space-y-3">
              {discovering && (
                <Alert kind="info">
                  <span className="flex items-center gap-1.5">
                    <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                    Waiting for the router's scan report. Paste the bootstrap one-liner on the
                    router if you have not yet — it usually reports within ~10 seconds.
                  </span>
                </Alert>
              )}
              {scan ? (
                <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-2">
                  <p className="text-[11px] font-black text-slate-700 dark:text-slate-200">
                    Discovered: {scan.system_info.identity || scan.system_info.board_name || 'device'}
                    {scan.system_info.model ? ` · ${scan.system_info.model}` : ''}
                    {scan.system_info.version ? ` · RouterOS ${scan.system_info.version}` : ''}
                    {scan.system_info.uptime ? ` · up ${scan.system_info.uptime}` : ''}
                  </p>
                  <Row label="Board">{scan.system_info.board_name || '—'}</Row>
                  <Row label="Architecture">{scan.system_info.architecture || '—'}</Row>
                  <Row label="Interfaces">{scan.interfaces.join(', ')}</Row>
                  <Row label="Detected WAN">{scan.wan_interface || '—'}</Row>
                  {scan.services.length > 0 && (
                    <Row label="Services">
                      {scan.services.map((s) => `${s.name}${s.active ? ' (active)' : ''}`).join(', ')}
                    </Row>
                  )}
                  <div className="flex justify-end pt-1">
                    <Button size="sm" onClick={() => setStep(4)}
                      icon={<ChevronRight className="w-3.5 h-3.5" />}>
                      Review interfaces
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2 items-center">
                  <Button size="sm" variant="secondary" disabled={discovering || routerId === null}
                    onClick={() => routerId !== null && void watchScan(routerId)}
                    icon={<RefreshCw className={cn('w-3.5 h-3.5', discovering && 'animate-spin')} />}>
                    {discovering ? 'Waiting for report…' : 'Waiting for report — retry now'}
                  </Button>
                  <span className="text-[11px] text-slate-500">
                    The wizard polls the engine's scan cache; it never dials the router directly.
                  </span>
                </div>
              )}
            </div>
          )}

          {/* ── 4. Interfaces ───────────────────────────────────────────── */}
          {step === 4 && scan && (
            <div className="grid gap-3 sm:grid-cols-3">
              {field('WAN interface', (
                <select className={cn(inputClass, 'mt-1')} value={wanIface}
                  onChange={(e) => setWanIface(e.target.value)}>
                  {scan.interfaces.map((i) => (
                    <option key={i} value={i}>{i}</option>
                  ))}
                  {!scan.interfaces.includes(wanIface) && wanIface && (
                    <option value={wanIface}>{wanIface}</option>
                  )}
                </select>
              ))}
              {field('HotSpot LAN interface', (
                <select className={cn(inputClass, 'mt-1')} value={hotspotIface}
                  onChange={(e) => setHotspotIface(e.target.value)}>
                  <option value="">— not enabled —</option>
                  {scan.interfaces.filter((i) => i !== wanIface).map((i) => (
                    <option key={i} value={i}>{i}</option>
                  ))}
                </select>
              ))}
              {field('PPPoE server interface', (
                <select className={cn(inputClass, 'mt-1')} value={pppoeIface}
                  onChange={(e) => setPppoeIface(e.target.value)}>
                  <option value="">— not enabled —</option>
                  {scan.interfaces.filter((i) => i !== wanIface).map((i) => (
                    <option key={i} value={i}>{i}</option>
                  ))}
                </select>
              ))}
              <div className="sm:col-span-3 flex justify-between">
                <Button size="sm" variant="secondary" onClick={() => setStep(3)}
                  icon={<ChevronLeft className="w-3.5 h-3.5" />}>Back</Button>
                <Button size="sm" onClick={() => setStep(5)}
                  icon={<ChevronRight className="w-3.5 h-3.5" />}>Choose services</Button>
              </div>
            </div>
          )}

          {/* ── 5. Services ─────────────────────────────────────────────── */}
          {step === 5 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {field('Services to enable', (
                <div className="mt-1 flex gap-3 items-center">
                  <label className="flex items-center gap-1 cursor-pointer text-[11px]">
                    <input type="radio" name="service_mode" value="hotspot"
                      checked={serviceMode === 'hotspot'}
                      onChange={() => setServiceMode('hotspot')} /> HotSpot
                  </label>
                  <label className="flex items-center gap-1 cursor-pointer text-[11px]">
                    <input type="radio" name="service_mode" value="pppoe"
                      checked={serviceMode === 'pppoe'}
                      onChange={() => setServiceMode('pppoe')} /> PPPoE
                  </label>
                  <label className="flex items-center gap-1 cursor-pointer text-[11px]">
                    <input type="radio" name="service_mode" value="both"
                      checked={serviceMode === 'both'}
                      onChange={() => setServiceMode('both')} /> Both
                  </label>
                </div>
              ))}
              {field('Subnet address (from scan)', (
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
              {field('WAN interface (from scan)', (
                <input className={cn(inputClass, 'mt-1')} value={wanIface}
                  readOnly disabled
                  title="Auto-detected from the router scan" />
              ))}
              <div className="sm:col-span-2 flex justify-between">
                <Button size="sm" variant="secondary" onClick={() => setStep(4)}
                  icon={<ChevronLeft className="w-3.5 h-3.5" />}>Back</Button>
                <Button size="sm" onClick={() => setStep(6)}
                  icon={<ChevronRight className="w-3.5 h-3.5" />}>Review</Button>
              </div>
            </div>
          )}

          {/* ── 6. Review ───────────────────────────────────────────────── */}
          {step === 6 && (
            <div className="space-y-3">
              <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-2">
                <Row label="Router">{identity.trim()}</Row>
                <Row label="Services">{serviceMode === 'both' ? 'HotSpot + PPPoE' : serviceMode === 'pppoe' ? 'PPPoE' : 'HotSpot'}</Row>
                <Row label="WAN">{wanIface}</Row>
                {serviceMode !== 'pppoe' && <Row label="HotSpot LAN">{hotspotIface || '—'}</Row>}
                {serviceMode !== 'hotspot' && <Row label="PPPoE server">{pppoeIface || '—'}</Row>}
                <Row label="Subnet">{cfg.subnet_address}/{cfg.cidr}</Row>
                {cfg.gateway && <Row label="Gateway">{cfg.gateway}</Row>}
                {(cfg.ip_pool_start || cfg.ip_pool_end) && (
                  <Row label="Pool">{cfg.ip_pool_start}–{cfg.ip_pool_end}</Row>
                )}
                <Row label="DNS">{cfg.dns_servers}</Row>
                <Row label="Bridge ports">{cfg.bridge_ports || '—'}</Row>
                <Row label="RouterOS">{scan ? (scan.system_info.version || 'unknown') : '—'}</Row>
              </div>
              <Alert kind="warning">
                Deploying applies this configuration to the router via the engine's polling agent.
                Previous active sessions for this router will be cancelled first.
              </Alert>
              <div className="flex justify-between">
                <Button size="sm" variant="secondary" onClick={() => setStep(5)}
                  icon={<ChevronLeft className="w-3.5 h-3.5" />}>Back</Button>
                <Button size="sm" variant="success" onClick={() => void deploy()} disabled={busy}
                  icon={<Plug className="w-3.5 h-3.5" />}>
                  {busy ? 'Deploying…' : 'Deploy configuration'}
                </Button>
              </div>
            </div>
          )}

          {/* ── 7. Deploy ───────────────────────────────────────────────── */}
          {step === 7 && (
            <div className="space-y-3">
              {runStatus === 'completed' && (
                <Alert kind="success">
                  <span className="flex items-start gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-px" />
                    The engine reported the workflow as completed. Check verification on the next step.
                  </span>
                </Alert>
              )}
              {(runStatus === 'failed' || runStatus === 'timeout') && (
                <Alert kind="error">
                  <span className="flex items-start gap-1.5">
                    <XCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
                    Provisioning {runStatus}. Read the log below, fix the cause on the router, then deploy again.
                  </span>
                </Alert>
              )}
              {runStatus !== 'completed' && runStatus !== 'failed' && runStatus !== 'timeout' && (
                <p className="text-[11px] text-slate-500 flex items-center gap-1.5">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Workflow running — the statuses below are polled from the engine every 3 seconds.
                </p>
              )}

              {wfSteps && wfSteps.length > 0 && (
                <div className="rounded-xl border border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-800">
                  {wfSteps.map((s, i) => (
                    <div key={i} className="flex items-center justify-between gap-2 px-4 py-2 text-xs">
                      <span className="font-mono text-slate-700 dark:text-slate-300">
                        {String(s.step ?? `step ${i + 1}`).replace(/_/g, ' ')}
                      </span>
                      <span className="flex items-center gap-2">
                        {typeof s.duration_seconds === 'number' && (
                          <span className="text-[10px] text-slate-400">{s.duration_seconds}s</span>
                        )}
                        {s.error ? (
                          <span className="text-[10px] text-rose-500 truncate max-w-[16rem]" title={String(s.error)}>
                            {String(s.error)}
                          </span>
                        ) : null}
                        <Badge value={STATUS_TONE[String(s.status)] ?? 'slate'} />
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap gap-2 justify-end">
                {runStatus === 'completed' && (
                  <Button size="sm" onClick={() => setStep(8)}
                    icon={<ChevronRight className="w-3.5 h-3.5" />}>
                    View verification
                  </Button>
                )}
                {(runStatus === 'failed' || runStatus === 'timeout') && (
                  <Button size="sm" variant="secondary" onClick={() => setStep(6)}>
                    Back to review
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* ── 8. Verify ───────────────────────────────────────────────── */}
          {step === 8 && (
            <div className="space-y-3">
              {direct === null && !verifying && (
                <p className="text-[11px] text-slate-500">No verification read yet for this router.</p>
              )}
              {direct && (
                <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-2.5">
                  <VerifyRow label="Bootstrap completed on the router" ok={direct.bootstrap_completed}
                    pending="The router has not confirmed the bootstrap yet — paste the one-liner if you have not." />
                  <VerifyRow label="Scan report stored" ok={direct.has_cached_scan}
                    pending="No scan report cached yet." />
                  <VerifyRow label="Polling agent installed" ok={direct.agent_installed}
                    pending="The agent is installed by the bootstrap one-liner — it is missing." />
                  <VerifyRow label="Agent checked in (online)" ok={direct.agent_online}
                    pending="The agent has not checked in recently. It phones home every ~30s; check the router's internet connection."
                    detail={direct.last_provisioned_at ? `Last provisioned: ${new Date(direct.last_provisioned_at).toLocaleString()}` : undefined} />
                  <Row label="Engine status">{direct.provisioning_status || '—'}</Row>
                </div>
              )}
              <div className="flex justify-end">
                <Button size="sm" variant="secondary" onClick={() => void runVerify()} disabled={verifying || routerId === null}
                  icon={<RefreshCw className={cn('w-3.5 h-3.5', verifying && 'animate-spin')} />}>
                  {verifying ? 'Reading…' : 'Re-check now'}
                </Button>
              </div>
              <Alert kind="info">
                Every state above is read straight from the engine's router record. Nothing turns
                green until the backend confirms it.
              </Alert>
            </div>
          )}

          {/* ── Live log (all steps after bootstrap) ────────────────────── */}
          {bootstrapCommand && <LogPane logs={logs} />}
        </div>
      </Card>

      <SessionsList sessions={sessions} busy={busy} onRefresh={() => void refreshSessions()} />
    </div>
  )
}










