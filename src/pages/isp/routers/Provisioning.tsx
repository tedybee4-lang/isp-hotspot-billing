/**
 * MikroTik auto-provisioning wizard.
 *
 * The ISP never types a router IP, username, password, RADIUS secret or API
 * key. We mint a short-lived single-use token, hand back one command, and the
 * router calls back with what it is. Nothing is marked online until a real
 * heartbeat arrives from the poll loop.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Plug, Copy, CheckCircle2, RefreshCw, ChevronRight, Terminal, ShieldCheck, Ban,
  ListChecks,
} from 'lucide-react'
import * as api from '../../../lib/data'
import type { ProvisioningSession, RouterCapabilities } from '../../../lib/data'
import {
  Card, CardHeader, Button, Alert, Spinner, Badge, EmptyState, inputClass, Modal,
} from '../../../components/ui'
import { cn } from '../../../utils/cn'

const STATE_LABEL: Record<string, string> = {
  created: 'Created',
  command_generated: 'Command ready',
  command_started: 'Command sent',
  router_detected: 'Router detected',
  capabilities_detected: 'Capabilities detected',
  waiting_for_selection: 'Awaiting your choice',
  configuring: 'Configuring',
  testing: 'Testing connection',
  online: 'Online',
  failed: 'Failed',
  expired: 'Expired',
  revoked: 'Revoked',
}

const STATE_TONE: Record<string, string> = {
  online: 'emerald', failed: 'rose', expired: 'slate', revoked: 'slate',
  router_detected: 'sky', capabilities_detected: 'sky',
  configuring: 'amber', testing: 'amber', waiting_for_selection: 'amber',
}

/** The ordered path a session walks through. */
const FLOW = [
  'command_generated', 'router_detected', 'capabilities_detected',
  'configuring', 'testing', 'online',
]

export function ProvisioningPage() {
  const [sessions, setSessions] = useState<ProvisioningSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [command, setCommand] = useState<
    { command: string; expiresAt: string } | null
  >(null)
  const [wizard, setWizard] = useState<
    { session: ProvisioningSession; caps: RouterCapabilities } | null
  >(null)
  /** Which session's stage list is open, if any. */
  const [stagesFor, setStagesFor] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setSessions(await api.fetchProvisioningSessions())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load sessions.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function begin() {
    setBusy('begin'); setError(null)
    try {
      const r = await api.startProvisioning('New router', 'hotspot')
      setCommand({ command: r.command, expiresAt: r.expiresAt })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start provisioning.')
    } finally {
      setBusy(null)
    }
  }

  async function detect(sessionId: string) {
    setBusy(sessionId); setError(null)
    try {
      const r = await api.provisionAction(sessionId, 'detect')
      const session = sessions.find((s) => s.id === sessionId)
      if (session) setWizard({ session, caps: r.capabilities as RouterCapabilities })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read the router.')
    } finally {
      setBusy(null)
    }
  }

  async function revoke(sessionId: string) {
    setBusy(sessionId); setError(null)
    try {
      await api.revokeProvisioning(sessionId)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not revoke.')
    } finally {
      setBusy(null)
    }
  }

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
        <Button size="sm" onClick={begin} disabled={busy === 'begin'} icon={<Plug className="w-3.5 h-3.5" />}>
          {busy === 'begin' ? 'Starting...' : '+ ADD MIKROTIK'}
        </Button>
      </div>

      {error && <Alert kind="error">{error}</Alert>}

      {command && (
        <Card>
          <CardHeader title="Run this on the router" icon={<Terminal className="w-4 h-4" />} />
          <div className="p-5 space-y-3">
            <p className="text-xs text-slate-600 dark:text-slate-300">
              Open the router terminal (Winbox: <span className="font-mono">New Terminal</span>)
              and paste these lines. Expires at
              <span className="font-mono ml-1">
                {new Date(command.expiresAt).toLocaleTimeString()}
              </span>.
            </p>
            <pre className="rounded-xl bg-slate-900 p-4 text-[11px] font-mono text-emerald-300 overflow-x-auto">
              {command.command}
            </pre>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" icon={<Copy className="w-3.5 h-3.5" />}
                onClick={() => void navigator.clipboard.writeText(command.command)}>
                Copy command
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setCommand(null)}>Done</Button>
            </div>
            <Alert kind="info">
              The token is single-use and stored hashed, scoped to this ISP only.
            </Alert>
          </div>
        </Card>
      )}

      {sessions.length === 0 ? (
        <Card className="p-8">
          <EmptyState icon={<Plug className="w-10 h-10" />} title="No provisioning yet"
            hint="Press Add MikroTik to generate your first command." />
        </Card>
      ) : (
        <div className="space-y-3">
          {sessions.map((s) => {
            const step = FLOW.indexOf(s.state)
            return (
              <Card key={s.id} className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-black text-slate-900 dark:text-white">{s.label}</p>
                      <Badge value={STATE_TONE[s.state] ?? 'slate'} />
                      <span className="text-[10px] font-mono text-slate-400">
                        {STATE_LABEL[s.state] ?? s.state}
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-400 font-mono mt-1">
                      {new Date(s.created_at).toLocaleString()}
                      {s.detected_at &&
                        ` - detected ${new Date(s.detected_at).toLocaleTimeString()}`}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => setStagesFor(s.id)}
                      title="Show provisioning stages"
                      className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">
                      <ListChecks className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => void detect(s.id)} disabled={busy === s.id}
                      title="Detect hardware"
                      className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">
                      <RefreshCw className={cn('w-3.5 h-3.5', busy === s.id && 'animate-spin')} />
                    </button>
                    {!['online', 'revoked'].includes(s.state) && (
                      <button onClick={() => void revoke(s.id)} disabled={busy === s.id}
                        title="Revoke this link"
                        className="p-1.5 rounded-lg text-slate-400 hover:bg-rose-50 dark:hover:bg-rose-500/10 hover:text-rose-600">
                        <Ban className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="mt-4 flex items-center gap-1">
                  {FLOW.map((f, i) => (
                    <div key={f} className={cn(
                      'h-1.5 flex-1 rounded-full',
                      step >= 0 && i <= step
                        ? s.state === 'online' ? 'bg-emerald-500' : 'bg-violet-500'
                        : 'bg-slate-200 dark:bg-slate-800',
                    )} />
                  ))}
                </div>

                {s.state === 'online' && (
                  <p className="mt-3 flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Online and reporting.
                  </p>
                )}
                {s.state !== 'online' && s.state !== 'revoked' && (
                  <p className="mt-3 text-[11px] text-slate-400">
                    Press refresh to re-check detection.
                  </p>
                )}
              </Card>
            )
          })}
        </div>
      )}

      {wizard && (
        <WizardModal session={wizard.session} caps={wizard.caps}
          onClose={() => setWizard(null)}
          onDone={async () => { setWizard(null); await load() }} />
      )}

      {stagesFor && (
        <StageProgress session={stagesFor} onClose={() => setStagesFor(null)} />
      )}
    </div>
  )
}

/** How each stage status is drawn, and what the operator is told. */
const STAGE_ICON: Record<string, string> = {
  success: 'text-emerald-500',
  failed: 'text-rose-500',
  running: 'text-amber-500',
  pending: 'text-slate-300 dark:text-slate-600',
  skipped: 'text-slate-400',
  unsupported: 'text-slate-400',
}

const STAGE_MARK: Record<string, string> = {
  success: 'OK', failed: 'X', running: '...', pending: '-',
  skipped: 'skip', unsupported: 'n/a',
}

/**
 * The real stage list, polled while a run is in flight.
 *
 * Shows the status the DATABASE recorded, not an optimistic animation. A stage
 * that failed says why it failed and names the stage, because "provisioning
 * failed" with no other detail is the single most useless message this page can
 * display.
 */
function StageProgress({
  session, onClose,
}: {
  session: string
  onClose: () => void
}) {
  const [report, setReport] = useState<api.ProvisioningStageReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const r = await api.fetchProvisioningStages(session)
        if (!cancelled) setReport(r)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not read stages.')
      }
    }
    void tick()
    // Poll while the run is unfinished. Once everything has settled there is
    // nothing left to watch, so the timer stops rather than hammering the API.
    const timer = setInterval(() => {
      const live = report?.stages.some(
        (st) => st.status === 'pending' || st.status === 'running')
      if (live || !report) void tick()
    }, 4000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [session, report])

  const failed = report?.stages.find((st) => st.status === 'failed')

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h2 className="text-sm font-black text-slate-900 dark:text-white">
            Provisioning stages
          </h2>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            Each step is applied by the network worker and recorded as it happens.
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={onClose}>Close</Button>
      </div>

      {error && <Alert kind="error">{error}</Alert>}
      {failed && (
        <Alert kind="error">
          <span className="font-bold">{failed.label} failed.</span> {failed.error}
        </Alert>
      )}
      {report?.online.blocked && (
        <Alert kind="warning">
          Not online yet: {report.online.reason}
          {report.online.stage ? ` (stage: ${report.online.stage})` : ''}
        </Alert>
      )}
      {report && !report.online.blocked && (
        <Alert kind="success">Every required stage passed. This router may go online.</Alert>
      )}

      <div className="mt-3 space-y-1">
        {(report?.stages ?? []).map((st) => (
          <div key={st.stage} className="flex items-start gap-3 py-1.5 border-b
            border-slate-100 dark:border-slate-800 last:border-0">
            <span className={cn('w-10 shrink-0 text-center text-[10px] font-mono font-bold',
              STAGE_ICON[st.status])}>
              {STAGE_MARK[st.status]}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-bold text-slate-700 dark:text-slate-200">
                {st.label}
                {!st.required && (
                  <span className="ml-1.5 font-normal text-slate-400">(optional)</span>
                )}
              </p>
              {st.error && (
                <p className="text-[10px] text-rose-600 dark:text-rose-400">{st.error}</p>
              )}
              {st.skipped_reason && (
                <p className="text-[10px] text-slate-400">{st.skipped_reason}</p>
              )}
              {st.duration_ms != null && st.status === 'success' && (
                <p className="text-[10px] text-slate-400 font-mono">{st.duration_ms} ms</p>
              )}
            </div>
          </div>
        ))}
      </div>

      {(report?.backups.length ?? 0) > 0 && (
        <div className="mt-4">
          <p className="text-[11px] font-bold text-slate-600 dark:text-slate-300">
            Backups on this router
          </p>
          <p className="text-[10px] text-slate-400">
            Stored on the router itself, never uploaded.
          </p>
          <ul className="mt-1 space-y-0.5">
            {report!.backups.map((b) => (
              <li key={b.id} className="text-[10px] font-mono text-slate-500">
                {b.filename} - {b.kind} - {new Date(b.created_at).toLocaleString()}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}
function WizardModal({
  session, caps, onClose, onDone,
}: {
  session: ProvisioningSession
  caps: RouterCapabilities
  onClose: () => void
  onDone: () => void | Promise<void>
}) {
  // Real discovered ports only. Bridges are included because a bridge IS a
  // legitimate HotSpot or management target on a real router; excluding them
  // would force an operator to pick a physical port the bridge hides behind.
  const candidates = caps.interfaces.filter((i) => !i.disabled)
  const [role, setRole] = useState(session.role)
  const [wan, setWan] = useState<string>(session.wan_interface ?? '')
  const [hs, setHs] = useState<string[]>(session.hotspot_interfaces ?? [])
  const [pp, setPp] = useState<string[]>(session.pppoe_interfaces ?? [])
  const [mgmt, setMgmt] = useState<string[]>([])
  // Address pools the router ALREADY has. Prefilled from the survey so the
  // operator picks rather than retypes; blank means "use what the router has".
  const [pools, setPools] = useState<api.DiscoveredPoolOption[]>([])
  const [hotspotPool, setHotspotPool] = useState('')
  const [pppLocal, setPppLocal] = useState('')
  const [pppRemote, setPppRemote] = useState('')
  const [radiusServer, setRadiusServer] = useState('')
  const [radiusEnabled, setRadiusEnabled] = useState(false)
  const [tunnel, setTunnel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [remedy, setRemedy] = useState<string | null>(null)
  const [queued, setQueued] = useState(false)
  const [sources, setSources] = useState<api.CopySourceRouter[]>([])
  const [copyFrom, setCopyFrom] = useState('')
  const [copyNote, setCopyNote] = useState<string | null>(null)

  // The pools and eligible copy sources are READS over what the platform already
  // knows. Fetched when the wizard opens, so the operator never has to invent a
  // range the router has already reported.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const p = await api.fetchPoolOptions(session.id)
        if (!cancelled) setPools(p.discovered)
      } catch { /* the fields below simply stay empty and the stage explains */ }
      try {
        const s = await api.fetchCopySources(session.id)
        if (!cancelled) setSources(s)
      } catch { /* Copy Plans stays unavailable rather than half-working */ }
    })()
    return () => { cancelled = true }
  }, [session.id])

  /**
   * Copy packages from another router of the same ISP.
   *
   * The browser decides nothing: it sends the source id and the backend applies
   * its own tenant check and its own copy logic. A refusal here comes back with
   * the server's reason rather than a local guess.
   */
  async function copyPackages() {
    if (!copyFrom) return
    setBusy(true); setCopyNote(null); setError(null)
    try {
      const r = await api.copyPlansFromRouter(session.id, copyFrom, ['hotspot', 'pppoe'])
      setCopyNote(r.message ?? `${r.plans} package(s) copied.`)
    } catch (e) {
      const err = e as { message?: string }
      setCopyNote(err.message ?? 'Could not copy the packages.')
    } finally {
      setBusy(false)
    }
  }

  const toggle = (list: string[], set: (v: string[]) => void, n: string) =>
    set(list.includes(n) ? list.filter((x) => x !== n) : [...list, n])

  /**
   * A port that is already the WAN must not also become a customer port.
   *
   * A HotSpot server and the upstream link on one interface is not a
   * configuration, it is a way to sell the ISP's own uplink to its subscribers.
   * Refusing here means the operator sees the conflict while looking at the
   * choice, rather than as an unexplained error after pressing Apply.
   */
  const wanConflict = wan === '' ? [] : [...hs, ...pp].filter((p) => p === wan)

  async function submit() {
    setBusy(true); setError(null); setRemedy(null)
    try {
      // This does not configure the router from the browser. The server runs the
      // management safety check against the router's discovered state and then
      // queues ONE job for the network worker.
      await api.configureRouter({
        sessionId: session.id,
        role,
        wanInterface: wan || null,
        hotspotInterfaces: role === 'pppoe' ? [] : hs,
        pppoeInterfaces: role === 'hotspot' ? [] : pp,
        managementInterfaces: mgmt,
        // Empty means "use what the router already has". The worker resolves the
        // real ranges, so an operator who leaves these blank is not left with a
        // broken PPPoE stage.
        hotspotPool: hotspotPool || undefined,
        pppLocal: pppLocal || undefined,
        pppRemote: pppRemote || undefined,
        radiusServer: radiusServer || undefined,
        radiusEnabled,
        tunnel: tunnel || undefined,
      })
      setQueued(true)
      await onDone()
    } catch (e) {
      // The refusal reason comes from the SERVER, which checked the router's
      // discovered state. The browser never decides this.
      const err = e as { message?: string; detail?: Record<string, unknown> }
      setError(err.message ?? 'Could not apply the configuration.')
      const r = err.detail?.remedy
      if (typeof r === 'string') setRemedy(r)
    } finally {
      setBusy(false)
    }
  }

  const chip = (on: boolean) => cn(
    'px-2 py-1 rounded-lg text-[11px] font-mono border',
    on
      ? 'border-violet-500 bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300'
      : 'border-slate-200 dark:border-slate-700 text-slate-500',
  )

  if (queued) {
    return (
      <Modal open onClose={onClose} title={`Configure ${session.label}`}>
        <div className="space-y-3">
          <Alert kind="success">
            Queued for the network worker. It applies each stage in order and
            records the real result of every one.
          </Alert>
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal open onClose={onClose} title={`Configure ${session.label}`}>
      <div className="space-y-4">
        <div className="rounded-xl bg-slate-50 dark:bg-slate-800 p-3 grid grid-cols-2 gap-2 text-[10px]">
          <span className="font-mono">Model: {caps.model ?? 'unknown'}</span>
          <span className="font-mono">RouterOS: {caps.version ?? 'unknown'}</span>
          <span className="font-mono">Arch: {caps.architecture ?? 'unknown'}</span>
          <span className="font-mono">RAM: {caps.ramMb ? `${caps.ramMb} MB` : 'unknown'}</span>
          <span className="font-mono">Serial: {caps.serial ?? 'unknown'}</span>
          <span className="font-mono">Interfaces: {caps.interfaces.length}</span>
        </div>

        {error && <Alert kind="error">{error}</Alert>}
        {remedy && <Alert kind="warning">{remedy}</Alert>}

        <div>
          <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300">
            What will this router run?
          </span>
          <div className="mt-1 grid grid-cols-3 gap-1 p-1 rounded-xl bg-slate-100 dark:bg-slate-800">
            {(['hotspot', 'pppoe', 'both'] as const).map((r) => (
              <button key={r} onClick={() => setRole(r)}
                className={cn(
                  'px-2 py-1.5 rounded-lg text-[11px] font-bold capitalize transition',
                  role === r
                    ? 'bg-white dark:bg-slate-700 text-violet-600 shadow-sm'
                    : 'text-slate-500',
                )}>
                {r === 'both' ? 'HotSpot + PPPoE' : r}
              </button>
            ))}
          </div>
        </div>

        {candidates.length === 0 ? (
          <Alert kind="warning">
            This router reported no usable interfaces. Check that the REST API
            account can read /interface.
          </Alert>
        ) : (
          <>
            <div>
              <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300">
                WAN interface
              </span>
              <select className={cn(inputClass, 'mt-1')} value={wan}
                onChange={(e) => setWan(e.target.value)}>
                <option value="">Leave as it is</option>
                {candidates.map((i) => (
                  <option key={i.name} value={i.name}>
                      {i.name} ({i.type}){i.isBridge ? ' - bridge' : ''}
                    </option>
                ))}
              </select>
            </div>

            {role !== 'pppoe' && (
              <div>
                <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300">
                  HotSpot interfaces
                </span>
                <div className="mt-1 flex flex-wrap gap-1">
                  {candidates.filter((i) => i.name !== wan).map((i) => (
                    <button key={i.name} onClick={() => toggle(hs, setHs, i.name)}
                      className={chip(hs.includes(i.name))}>
                      {i.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {role !== 'hotspot' && (
              <div>
                <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300">
                  PPPoE interfaces
                </span>
                <div className="mt-1 flex flex-wrap gap-1">
                  {candidates.filter((i) => i.name !== wan).map((i) => (
                    <button key={i.name} onClick={() => toggle(pp, setPp, i.name)}
                      className={chip(pp.includes(i.name))}>
                      {i.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300">
                Management interface
              </span>
              <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
                Keep at least one port you can reach the router on. If your
                selection would leave none, the configuration is refused.
              </p>
              <div className="mt-1 flex flex-wrap gap-1">
                {candidates.map((i) => (
                  <button key={i.name} onClick={() => toggle(mgmt, setMgmt, i.name)}
                    className={chip(mgmt.includes(i.name))}>
                    {i.name}
                  </button>
                ))}
              </div>
            </div>

            {wanConflict.length > 0 && (
              <Alert kind="warning">
                {wanConflict.join(', ')} is selected as the WAN and also as a
                customer port. That would sell your own uplink to subscribers, so
                it has been taken off the customer side.
              </Alert>
            )}

            {/* ── HotSpot pool: only when HotSpot is on ── */}
            {role !== 'pppoe' && (
              <div>
                <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300">
                  HotSpot address pool
                </span>
                <select className={cn(inputClass, 'mt-1')} value={hotspotPool}
                  onChange={(e) => setHotspotPool(e.target.value)}>
                  <option value="">
                    {pools.length > 0
                      ? 'Use the largest pool found on the router'
                      : 'No pool found - the router reported none'}
                  </option>
                  {pools.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name} ({p.ranges})
                    </option>
                  ))}
                </select>
                {pools.length === 0 && (
                  <p className="text-[10px] text-slate-400 mt-0.5">
                    HotSpot will run without a pool until one is added on the
                    router under IP &gt; Pools.
                  </p>
                )}
              </div>
            )}

            {/* ── PPPoE ranges: only when PPPoE is on ── */}
            {role !== 'hotspot' && (
              <div>
                <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300">
                  PPPoE address ranges
                </span>
                <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
                  Leave blank to use a range found on the router.
                </p>
                <input className={cn(inputClass, 'mt-1 font-mono')} value={pppLocal}
                  placeholder="10.0.0.2-10.0.127"
                  onChange={(e) => setPppLocal(e.target.value)} />
                <input className={cn(inputClass, 'mt-1 font-mono')} value={pppRemote}
                  placeholder="10.0.128.2-10.0.255"
                  onChange={(e) => setPppRemote(e.target.value)} />
              </div>
            )}

            {/* ── RADIUS ── */}
            <div>
              <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300">
                RADIUS
              </span>
              <label className="mt-1 flex items-center gap-2 text-[11px] text-slate-600 dark:text-slate-300">
                <input type="checkbox" checked={radiusEnabled}
                  onChange={(e) => setRadiusEnabled(e.target.checked)} />
                Authenticate subscribers through RADIUS
              </label>
              {radiusEnabled && (
                <input className={cn(inputClass, 'mt-1 font-mono')} value={radiusServer}
                  placeholder="radius.yourisp.co.ke"
                  onChange={(e) => setRadiusServer(e.target.value)} />
              )}
              <p className="text-[10px] text-slate-400 mt-0.5">
                FreeRADIUS stays where it is. If this is on and the router cannot
                reach the server, the run stops at the RADIUS stage rather than
                reporting the router healthy.
              </p>
            </div>

            {/* ── Secure tunnel ── */}
            <div>
              <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300">
                Management tunnel
              </span>
              <select className={cn(inputClass, 'mt-1')} value={tunnel}
                onChange={(e) => setTunnel(e.target.value)}>
                <option value="">Manage over the LAN (no tunnel)</option>
                <option value="wireguard">WireGuard (RouterOS 7.1+)</option>
              </select>
              {tunnel === 'wireguard' && (
                <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-0.5">
                  If this firmware has no WireGuard the run FAILS rather than being
                  marked unsupported. Without the tunnel the router cannot be
                  reached, so it must not be reported as healthy.
                </p>
              )}
            </div>

            {/* ── Copy plans from another of this ISP's routers ── */}
            <div>
              <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300">
                Copy packages from another router
              </span>
              {sources.length === 0 ? (
                <p className="text-[10px] text-slate-400 mt-0.5">
                  No other routers on your account to copy from.
                </p>
              ) : (
                <div className="flex gap-1 mt-1">
                  <select className={cn(inputClass, 'flex-1')} value={copyFrom}
                    onChange={(e) => setCopyFrom(e.target.value)}>
                    <option value="">Choose a router...</option>
                    {sources.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}{s.board_name ? ` - ${s.board_name}` : ''}
                      </option>
                    ))}
                  </select>
                  <Button size="sm" variant="secondary" type="button"
                    disabled={!copyFrom || busy}
                    onClick={() => void copyPackages()}>
                    Copy
                  </Button>
                </div>
              )}
              {copyNote && (
                <p className="text-[10px] text-slate-500 mt-1">{copyNote}</p>
              )}
              <p className="text-[10px] text-slate-400 mt-0.5">
                Copies your package definitions only. Prices, payments and past
                invoices are never copied or changed.
              </p>
            </div>
          </>
        )}

        <Alert kind="info">
          <span className="flex items-start gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-px" />
            The script only creates objects tagged NETISP. Your firewall, WAN,
            VLANs and existing users are never touched.
          </span>
        </Alert>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit}
            disabled={busy || candidates.length === 0 || wanConflict.length > 0}
            icon={<ChevronRight className="w-3.5 h-3.5" />}>
            {busy ? 'Queueing...' : 'Apply configuration'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}