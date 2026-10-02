/**
 * Router management: register a MikroTik, store its credentials, test the
 * connection, and see real telemetry reported by the poller.
 */
import { useCallback, useState } from 'react'
import {
  Plus, Trash2, RefreshCw, Plug, Wifi, WifiOff, Wrench, ShieldCheck,
  Search, Pencil, Power, AlertTriangle,
} from 'lucide-react'
import { useTenant } from '../../../context/TenantContext'
import * as api from '../../../lib/data'
import { config } from '../../../lib/config'
import type { Node } from '../../../lib/types'
import {
  Card, Button, Badge, EmptyState, Spinner, Alert, Modal, inputClass,
} from '../../../components/ui'
import { cn } from '../../../utils/cn'

function bytesToMb(v: number | null): string {
  return v === null ? '—' : `${Math.round(v / 1_048_576).toLocaleString()} MB`
}

function uptime(seconds: number | null): string {
  if (seconds === null) return '—'
  const d = Math.floor(seconds / 86_400)
  const h = Math.floor((seconds % 86_400) / 3_600)
  const m = Math.floor((seconds % 3_600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

interface Draft {
  id?: string
  name: string
  host: string
  apiPort: number
  model: string
  notes: string
}

const EMPTY: Draft = { name: '', host: '', apiPort: 8728, model: '', notes: '' }

export function RoutersPage() {
  const { nodes, loading, reload } = useTenant()
  const [editing, setEditing] = useState<Draft | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key); setError(null); setNotice(null)
    try { await fn() } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.')
    } finally { setBusy(null) }
  }

  const pollAll = useCallback(async () => {
    await reload()
    const enabled = nodes.filter((n) => n.enabled && n.host)
    await Promise.allSettled(
      enabled.map((n) => api.pollRouterNow(n.id).then(() => api.pollRouterNow(n.id))),
    )
    await reload()
  }, [nodes, reload])

  if (loading) return <Spinner label="Loading routers..." />

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-start gap-3">
          <Plug className="w-5 h-5 text-violet-600 dark:text-violet-400 mt-0.5" />
          <div>
            <h1 className="text-xl font-black tracking-tight text-slate-900 dark:text-white">
              Routers
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Telemetry is read from each MikroTik over the RouterOS REST API.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm" variant="secondary" icon={<RefreshCw className="w-3.5 h-3.5" />}
            onClick={() => void run('poll', pollAll)}
            disabled={busy === 'poll'}
          >
            {busy === 'poll' ? 'Polling...' : 'Poll now'}
          </Button>
          <Button size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setEditing({ ...EMPTY })}>
            Add router
          </Button>
        </div>
      </div>

      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}

      {nodes.length === 0 ? (
        <Card className="p-8">
          <EmptyState
            icon={<Plug className="w-10 h-10" />}
            title="No routers yet"
            hint="Add a MikroTik to start collecting live telemetry."
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {nodes.map((n) => (
            <RouterCard
              key={n.id}
              node={n}
              busy={busy}
              onEdit={() => setEditing({
                id: n.id, name: n.name, host: n.host ?? '',
                apiPort: n.api_port ?? 8728, model: n.model ?? '', notes: n.notes ?? '',
              })}
              onToggle={() => void run(`t-${n.id}`, async () => {
                await api.setNodeEnabled(n.id, !n.enabled)
                await reload()
              })}
              onPoll={() => void run(`p-${n.id}`, async () => {
                await api.pollRouterNow(n.id)
                await reload()
              })}
              onDelete={() => void run(`d-${n.id}`, async () => {
                await api.deleteNode(n.id)
                setNotice(`Removed ${n.name}.`)
                await reload()
              })}
            />
          ))}
        </div>
      )}

      {editing && (
        <RouterModal
          draft={editing}
          busy={busy === 'save' || busy === 'test'}
          onClose={() => setEditing(null)}
          onSaved={async (msg) => {
            setEditing(null)
            setNotice(msg)
            await reload()
          }}
          onRun={run}
        />
      )}
    </div>
  )
}

function RouterCard({
  node: n, busy, onEdit, onToggle, onPoll, onDelete,
}: {
  node: Node
  busy: string | null
  onEdit: () => void
  onToggle: () => void
  onPoll: () => void
  onDelete: () => void
}) {
  const online = n.status === 'online'
  return (
    <Card className={cn('p-5', !n.enabled && 'opacity-60')}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <span className={cn(
            'w-9 h-9 rounded-xl grid place-items-center shrink-0',
            online ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15'
              : 'bg-slate-100 text-slate-400 dark:bg-slate-800',
          )}>
            {online ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-black text-slate-900 dark:text-white truncate">{n.name}</p>
            <p className="text-[10px] text-slate-400 font-mono truncate">
              {n.host ?? 'no host'}{n.host ? `:${n.api_port ?? 8728}` : ''}
            </p>
          </div>
        </div>
        <div className="flex gap-1 shrink-0">
          <button onClick={onToggle} title={n.enabled ? 'Stop polling' : 'Start polling'}
            className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700">
            <Power className={cn('w-3.5 h-3.5', n.enabled && 'text-emerald-500')} />
          </button>
          <button onClick={onEdit} title="Edit"
            className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700">
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button onClick={onPoll} title="Poll now"
            className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700">
            <RefreshCw className={cn('w-3.5 h-3.5', busy === `p-${n.id}` && 'animate-spin')} />
          </button>
          <button onClick={onDelete} title="Remove"
            className="p-1.5 rounded-lg text-slate-400 hover:bg-rose-50 dark:hover:bg-rose-500/10 hover:text-rose-600">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Status" value={online ? 'Online' : n.status === 'maintenance' ? 'Maintenance' : 'Offline'} />
        <Stat label="Active users" value={online ? String(n.active_users) : '—'} />
        <Stat label="CPU" value={n.cpu_load !== null ? `${n.cpu_load}%` : 'No data'} />
        <Stat label="RAM" value={n.ram_used_mb !== null ? bytesToMb(n.ram_used_mb) : 'No data'} />
        <Stat label="Model" value={n.model ?? 'No data'} />
        <Stat label="RouterOS" value={n.os_version ?? 'No data'} />
        <Stat label="Serial" value={n.serial_number ?? 'No data'} />
        <Stat label="Uptime" value={uptime(n.uptime_seconds)} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] text-slate-400">
        {n.last_latency_ms !== null && <span className="font-mono">{n.last_latency_ms}ms</span>}
        <span>Last poll {n.last_poll_at ? new Date(n.last_poll_at).toLocaleString() : 'never'}</span>
        {!n.enabled && <Badge value="polling paused" />}
      </div>

      {n.last_error && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-rose-50 dark:bg-rose-500/10 px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5 text-rose-600 shrink-0 mt-0.5" />
          <p className="text-[11px] text-rose-700 dark:text-rose-300">{n.last_error}</p>
        </div>
      )}
    </Card>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider font-mono">{label}</p>
      <p className="text-xs font-bold text-slate-700 dark:text-slate-200 truncate">{value}</p>
    </div>
  )
}

function RouterModal({
  draft, busy, onClose, onSaved, onRun,
}: {
  draft: Draft
  busy: boolean
  onClose: () => void
  onSaved: (msg: string) => void | Promise<void>
  onRun: (key: string, fn: () => Promise<void>) => Promise<void>
}) {
  const [form, setForm] = useState(draft)
  const [creds, setCreds] = useState({ username: '', password: '' })
  const [testResult, setTestResult] = useState<api.RouterConnectionTest | null>(null)

  const set = (k: keyof Draft, v: string | number) => setForm((f) => ({ ...f, [k]: v }))

  return (
    <Modal open onClose={onClose} title={form.id ? 'Edit router' : 'Add router'}>
      <div className="space-y-4">
        <label className="block">
          <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300">Name</span>
          <input className={cn(inputClass, 'mt-1')} value={form.name}
            onChange={(e) => set('name', e.target.value)} placeholder="Nairobi Core Hub" />
        </label>

        <div className="grid grid-cols-3 gap-3">
          <label className="block col-span-2">
            <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300">Host or IP</span>
            <input className={cn(inputClass, 'mt-1')} value={form.host}
              onChange={(e) => set('host', e.target.value)} placeholder="10.0.0.1" />
          </label>
          <label className="block">
            <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300">REST port</span>
            <input className={cn(inputClass, 'mt-1')} type="number" value={form.apiPort}
              onChange={(e) => set('apiPort', Number(e.target.value))} />
          </label>
        </div>

        {config.mode === 'live' && (
          <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3 space-y-3">
            <p className="text-[11px] font-bold text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
              RouterOS credentials
            </p>
            <p className="text-[10px] text-slate-400">
              Stored encrypted. Never sent back to the browser, and not readable by tenant staff.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <input className={inputClass} value={creds.username} placeholder="username"
                onChange={(e) => setCreds((c) => ({ ...c, username: e.target.value }))} />
              <input className={inputClass} type="password" value={creds.password} placeholder="password"
                onChange={(e) => setCreds((c) => ({ ...c, password: e.target.value }))} />
            </div>
            <Button
              size="sm" variant="secondary" disabled={busy || !form.host || !creds.username}
              onClick={() => void onRun('test', async () => {
                const r = await api.testRouterConnection({
                  host: form.host, port: Number(form.apiPort),
                  username: creds.username, password: creds.password,
                })
                setTestResult(r)
              })}
              icon={<Search className="w-3.5 h-3.5" />}
            >
              Test connection
            </Button>
            {testResult && (
              testResult.ok
                ? <Alert kind="success">
                    Reached {testResult.identity ?? 'router'} ({testResult.model}, RouterOS {testResult.version})
                    in {testResult.latencyMs}ms.
                  </Alert>
                : <Alert kind="error">{testResult.error}</Alert>
            )}
          </div>
        )}

        <label className="block">
          <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300">Notes</span>
          <input className={cn(inputClass, 'mt-1')} value={form.notes}
            onChange={(e) => set('notes', e.target.value)} placeholder="Optional" />
        </label>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            disabled={busy || !form.name || !form.host}
            onClick={() => void onRun('save', async () => {
              await api.saveNode({
                id: form.id, name: form.name, host: form.host,
                apiPort: Number(form.apiPort), model: form.model || null,
                notes: form.notes || null,
              })
              if (form.id && creds.username && creds.password) {
                await api.saveRouterCredentials({
                  nodeId: form.id, username: creds.username, password: creds.password,
                })
              }
              await onSaved(form.id ? 'Router updated.' : 'Router added. Add credentials to start polling.')
            })}
            icon={<Wrench className="w-3.5 h-3.5" />}
          >
            {form.id ? 'Save changes' : 'Add router'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
