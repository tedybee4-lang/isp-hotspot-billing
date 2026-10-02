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
    </div>
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
  const candidates = caps.interfaces.filter((i) => !i.disabled && !i.isBridge)
  const [role, setRole] = useState(session.role)
  const [wan, setWan] = useState<string>('')
  const [hs, setHs] = useState<string[]>([])
  const [pp, setPp] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = (list: string[], set: (v: string[]) => void, n: string) =>
    set(list.includes(n) ? list.filter((x) => x !== n) : [...list, n])

  async function submit() {
    setBusy(true); setError(null)
    try {
      await api.saveProvisioningAnswers(session.id, {
        role,
        wan_interface: wan || null,
        hotspot_interfaces: role === 'pppoe' ? [] : hs,
        pppoe_interfaces: role === 'hotspot' ? [] : pp,
      })
      const r = await api.provisionAction(session.id, 'script')
      if (r.script) await navigator.clipboard.writeText(String(r.script))
      await onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not apply the configuration.')
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
                  <option key={i.name} value={i.name}>{i.name} ({i.type})</option>
                ))}
              </select>
            </div>

            {role !== 'pppoe' && (
              <div>
                <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300">
                  HotSpot interfaces
                </span>
                <div className="mt-1 flex flex-wrap gap-1">
                  {candidates.map((i) => (
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
                  {candidates.map((i) => (
                    <button key={i.name} onClick={() => toggle(pp, setPp, i.name)}
                      className={chip(pp.includes(i.name))}>
                      {i.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
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
          <Button onClick={submit} disabled={busy || candidates.length === 0}
            icon={<ChevronRight className="w-3.5 h-3.5" />}>
            {busy ? 'Applying...' : 'Apply configuration'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}