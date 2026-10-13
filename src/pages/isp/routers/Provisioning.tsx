/**
 * Router Provisioning — rebuilt, driven by the FastAPI provision engine.
 *
 * The engine (backend/) owns everything router-side. This page lets an
 * operator:
 *
 *   1. See the real provisioning sessions for their tenant (never mocked).
 *   2. Generate a bootstrap one-liner for a new router (identity + WAN
 *      interface), which the operator pastes into the router terminal
 *      (Winbox: New Terminal).
 *   3. Copy that command to the clipboard with clear success/failure feedback.
 *
 * Authentication is entirely Supabase-session based: every request attaches
 * the signed-in user's real access token. Nothing here stores or forges a
 * token, and no success is ever claimed that the backend did not confirm.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Plug, Copy, CheckCircle2, RefreshCw, ChevronRight, Terminal,
  Radio, ListChecks, XCircle, Router as RouterIcon,
} from 'lucide-react'
import {
  Card, CardHeader, Button, Alert, Spinner, Badge, EmptyState, inputClass,
  Table, Th, Td,
} from '../../../components/ui'
import {
  upsertRouter, createSession, getBootstrapCommand, listSessions,
  type BackendRouter, type ProvisionSession, type BootstrapCommand,
} from '../../../lib/provisionApi'
import { copyText } from '../../../lib/clipboard'
import { cn } from '../../../utils/cn'

interface LogLine {
  time: string
  level: string
  message: string
}

const now = () => new Date().toLocaleTimeString()

/** Maps a backend provisioning status onto a badge tone. */
const STATUS_TONE: Record<string, string> = {
  completed: 'success',
  in_progress: 'in_progress',
  pending: 'pending',
  failed: 'failed',
  cancelled: 'cancelled',
  timeout: 'expired',
}

const DEFAULT_API_PORT = 8728
const DEFAULT_WAN_INTERFACE = 'ether1'
const SERVICE_TYPE = 'hotspot'

function lineLevel(level: string): string {
  switch (level) {
    case 'success': return 'text-emerald-300'
    case 'error': return 'text-rose-300'
    case 'warning': return 'text-amber-300'
    default: return 'text-slate-300'
  }
}

/** Human-readable timestamp, or an em dash when the value is missing. */
function stamp(value: string | null): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString()
}

/* ── Skeleton shown while the session list loads ─────────────────────────── */

function SkeletonRow() {
  return (
    <div className="animate-pulse flex items-center gap-3 px-4 py-3 border-b border-slate-100 dark:border-slate-800/70">
      <div className="h-3 w-40 rounded bg-slate-200 dark:bg-slate-700" />
      <div className="h-3 w-16 rounded bg-slate-200 dark:bg-slate-700" />
      <div className="h-3 w-28 rounded bg-slate-200 dark:bg-slate-700 ml-auto" />
      <div className="h-5 w-20 rounded-full bg-slate-200 dark:bg-slate-700" />
    </div>
  )
}

/* ── Copy button with success/failure feedback ───────────────────────────── */

function CopyButton({ text, label = 'Copy command' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle')

  async function copy() {
    setState(await copyText(text) === 'copied' ? 'done' : 'failed')
    window.setTimeout(() => setState('idle'), 2400)
  }

  return (
    <Button size="sm" variant="secondary" onClick={() => void copy()} icon={
      state === 'done' ? <CheckCircle2 className="w-3.5 h-3.5" />
        : state === 'failed' ? <XCircle className="w-3.5 h-3.5" />
          : <Copy className="w-3.5 h-3.5" />
    }>
      {state === 'done' ? 'Copied!' : state === 'failed' ? 'Copy failed' : label}
    </Button>
  )
}

/* ── Provisioning sessions ───────────────────────────────────────────────── */

function SessionsTable({
  sessions, busy, onRefresh,
}: {
  sessions: ProvisionSession[]
  busy: boolean
  onRefresh: () => void
}) {
  return (
    <Card>
      <div className="flex items-center justify-between px-5 pt-4">
        <div>
          <h2 className="text-sm font-black text-slate-900 dark:text-white flex items-center gap-2">
            <ListChecks className="w-4 h-4" /> Provisioning sessions
          </h2>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
            Live sessions for your tenant, most recent first.
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={onRefresh} disabled={busy}
          icon={<RefreshCw className={cn('w-3.5 h-3.5', busy && 'animate-spin')} />}>
          Refresh
        </Button>
      </div>

      {busy ? (
        <div className="p-5 pt-3 space-y-0">
          {[0, 1, 2].map((i) => <SkeletonRow key={i} />)}
        </div>
      ) : sessions.length === 0 ? (
        <EmptyState
          icon={<Radio className="w-10 h-10" />}
          title="No provisioning sessions yet"
          hint="Generate a bootstrap command to start your first run." />
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block pt-3">
            <Table>
              <thead>
                <tr>
                  <Th>Session</Th>
                  <Th>Router</Th>
                  <Th>Service</Th>
                  <Th>Created</Th>
                  <Th>Completed</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.session_id}>
                    <Td className="font-mono text-[11px]">{s.session_id}</Td>
                    <Td className="font-mono text-[11px]">#{s.router_id}</Td>
                    <Td>{s.service_type ?? '—'}</Td>
                    <Td className="text-[11px]">{stamp(s.created_at)}</Td>
                    <Td className="text-[11px]">{stamp(s.completed_at)}</Td>
                    <Td><Badge value={STATUS_TONE[s.status] ?? 'cancelled'} /></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden p-5 pt-3 space-y-2">
            {sessions.map((s) => (
              <div key={s.session_id}
                className="rounded-xl border border-slate-200 dark:border-slate-700 px-3 py-2.5 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-mono text-slate-500 truncate">{s.session_id}</p>
                  <Badge value={STATUS_TONE[s.status] ?? 'cancelled'} />
                </div>
                <p className="text-[11px] text-slate-500">
                  router #{s.router_id}{s.service_type ? ` · ${s.service_type}` : ''}
                </p>
                <p className="text-[11px] text-slate-400">
                  {stamp(s.created_at)}{s.completed_at ? ` → ${stamp(s.completed_at)}` : ''}
                </p>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  )
}

/* ── Live log pane ───────────────────────────────────────────────────────── */

function LogPane({ logs }: { logs: LogLine[] }) {
  return (
    <div className="rounded-xl bg-slate-900 p-4 h-40 overflow-y-auto font-mono text-[11px] leading-relaxed">
      {logs.length === 0 ? (
        <p className="text-slate-500">
          Session events appear here. Paste the bootstrap command on the router to begin.
        </p>
      ) : logs.map((l, i) => (
        <p key={i} className={lineLevel(l.level)}>
          <span className="text-slate-500">{l.time}</span> {l.message}
        </p>
      ))}
    </div>
  )
}

/* ── Main page ───────────────────────────────────────────────────────────── */

export function ProvisioningPage() {
  const [sessions, setSessions] = useState<ProvisionSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Bootstrap panel state
  const [identity, setIdentity] = useState('')
  const [wanIface, setWanIface] = useState(DEFAULT_WAN_INTERFACE)
  const [busy, setBusy] = useState(false)
  const [router, setRouter] = useState<BackendRouter | null>(null)
  const [bootstrap, setBootstrap] = useState<BootstrapCommand | null>(null)
  const [logs, setLogs] = useState<LogLine[]>([])

  const mountRef = useRef(true)

  const pushLog = useCallback((level: string, message: string) => {
    setLogs((prev) => [...prev.slice(-199), { time: now(), level, message }])
  }, [])

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await listSessions())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load sessions.')
    }
  }, [])

  /**
   * Load sessions on mount only after authentication is initialised. The API
   * client resolves the Supabase session itself, so a never-signed-in visitor
   * gets the auth error surfaced as a normal session error.
   */
  useEffect(() => {
    mountRef.current = true
    setLoading(true)
    void refreshSessions().finally(() => {
      if (mountRef.current) setLoading(false)
    })
    return () => { mountRef.current = false }
  }, [refreshSessions])

  function resetBootstrap() {
    setRouter(null)
    setBootstrap(null)
    setLogs([])
    setError(null)
  }

  /** Step 1: create the router row + create-only session, then get the command. */
  async function generate() {
    const name = identity.trim()
    if (!name) return
    setBusy(true); setError(null); resetBootstrap()
    try {
      const r = await upsertRouter({
        name,
        ip_address: '192.168.88.1',
        api_port: DEFAULT_API_PORT,
      })
      setRouter(r)

      const s = await createSession(r.id, SERVICE_TYPE, { identity: r.name })
      pushLog('info', `Provisioning session ${s.session_id.slice(0, 8)}… created.`)

      const b = await getBootstrapCommand({
        identity: r.name,
        api_port: r.port,
        interface: wanIface,
        ip_address: r.ip_address,
        session_id: s.session_id,
        router_id: r.id,
      })
      setBootstrap(b)
      pushLog('success', 'Bootstrap command generated. Paste it into the router terminal.')
      // Refresh the sessions list so the new session is visible immediately.
      void refreshSessions()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not generate the bootstrap command.'
      setError(msg)
      pushLog('error', msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-start gap-3">
          <Plug className="w-6 h-6 text-violet-600 dark:text-violet-400 mt-0.5" />
          <div>
            <h1 className="text-xl font-black tracking-tight text-slate-900 dark:text-white">
              Router Provisioning
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Enroll a MikroTik router with one command and track every run.
            </p>
          </div>
        </div>
        <Button size="sm" onClick={resetBootstrap} icon={<Plug className="w-3.5 h-3.5" />}>
          + Provision router
        </Button>
      </div>

      {/* Global error with retry */}
      {error && (
        <div className="space-y-2">
          <Alert kind="error">{error}</Alert>
          <Button size="sm" variant="secondary" onClick={() => { setError(null); void refreshSessions() }}
            icon={<RefreshCw className="w-3.5 h-3.5" />}>
            Retry
          </Button>
        </div>
      )}

      {/* Bootstrap generation panel */}
      <Card>
        <CardHeader title="Bootstrap a new router" icon={<Terminal className="w-4 h-4" />}
          subtitle="Generates a RouterOS one-liner the router runs to enrol itself." />
        <div className="p-5 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300">Router identity</span>
              <input className={cn(inputClass, 'mt-1')} value={identity}
                onChange={(e) => setIdentity(e.target.value)}
                placeholder="e.g. Office Router" autoComplete="off" maxLength={64} />
            </label>
            <label className="block">
              <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300">WAN interface</span>
              <input className={cn(inputClass, 'mt-1')} value={wanIface}
                onChange={(e) => setWanIface(e.target.value)} autoComplete="off" />
            </label>
            <div className="sm:col-span-2">
              <Alert kind="info">
                The wizard creates the router record and a provisioning session, then returns a
                one-liner to paste into the router terminal (Winbox: New Terminal). The session id
                is embedded in the callback URL, so the router reports back on its own.
              </Alert>
            </div>
            <div className="sm:col-span-2 flex justify-end">
              <Button onClick={() => void generate()} disabled={busy || !identity.trim()}
                icon={<ChevronRight className="w-3.5 h-3.5" />}>
                {busy ? 'Generating…' : 'Generate bootstrap command'}
              </Button>
            </div>
          </div>

          {bootstrap && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-bold text-slate-700 dark:text-slate-200 flex items-center gap-2">
                  <RouterIcon className="w-3.5 h-3.5" /> {router?.name}
                </p>
                <CopyButton text={bootstrap.command} />
              </div>
              <pre className="rounded-xl bg-slate-900 p-4 text-[11px] font-mono text-emerald-300 overflow-x-auto whitespace-pre-wrap">
                {bootstrap.command}
              </pre>
              {bootstrap.bootstrap_already_done && (
                <Alert kind="info">
                  This router already completed bootstrap and has stored API credentials.
                </Alert>
              )}
              {bootstrap.ping_check && !bootstrap.ping_check.reachable && (
                <Alert kind="warning">
                  Device not responding to a ping/check at {router?.ip_address}. The command may
                  still work — run it on the router; its callback reaches the engine even from
                  behind NAT.
                </Alert>
              )}
              {bootstrap.notes.length > 0 && (
                <ul className="text-[11px] text-slate-500 space-y-1">
                  {bootstrap.notes.map((n, i) => <li key={i}>• {n}</li>)}
                </ul>
              )}
              <LogPane logs={logs} />
            </div>
          )}
        </div>
      </Card>

      {/* Sessions */}
      {loading ? (
        <Card>
          <div className="p-5">
            <Spinner label="Loading provisioning sessions..." />
          </div>
        </Card>
      ) : (
        <SessionsTable sessions={sessions} busy={busy}
          onRefresh={() => void refreshSessions()} />
      )}
    </div>
  )
}