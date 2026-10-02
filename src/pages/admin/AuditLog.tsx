import { useEffect, useMemo, useState } from 'react'
import { ScrollText, Filter, RefreshCw } from 'lucide-react'
import { fetchAuditLogs } from '../../lib/data'
import type { AuditLog } from '../../lib/types'
import { Badge, Button, Card, EmptyState, Spinner, Table, Td, Th } from '../../components/ui'

const ACTION_TONES: Record<string, string> = {
  INSERT: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  UPDATE: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  DELETE: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
}

export default function AuditLogPage() {
  const [logs, setLogs] = useState<AuditLog[] | null>(null)
  const [op, setOp] = useState<string>('all')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      setLogs(await fetchAuditLogs(200))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const ops = useMemo(
    () => ['all', ...new Set((logs ?? []).map((l) => l.action.split(':')[0]))],
    [logs],
  )

  const filtered = (logs ?? []).filter((l) => op === 'all' || l.action.startsWith(op))

  if (error) {
    return <Card className="p-6"><p className="text-sm font-bold text-rose-600">{error}</p></Card>
  }
  if (!logs) return <Spinner label="Loading audit trail…" />

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">Audit log</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Every privileged action taken on this platform, in order.
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={load} loading={loading}
          icon={<RefreshCw className="w-3.5 h-3.5" />}>
          Refresh
        </Button>
      </div>

      <Card>
        <div className="p-4 flex items-center gap-3 border-b border-slate-200 dark:border-slate-800">
          <Filter className="w-4 h-4 text-slate-400 shrink-0" />
          <div className="flex gap-1 p-1 rounded-xl bg-slate-100 dark:bg-slate-800">
            {ops.map((o) => (
              <button
                key={o}
                onClick={() => setOp(o)}
                className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold capitalize transition ${
                  op === o
                    ? 'bg-white dark:bg-slate-700 text-violet-600 dark:text-violet-300 shadow-sm'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-700'
                }`}
              >
                {o}
              </button>
            ))}
          </div>
          <span className="ml-auto text-[11px] text-slate-400 font-mono">{filtered.length} entries</span>
        </div>

        {filtered.length === 0 ? (
          <EmptyState icon={<ScrollText className="w-10 h-10" />} title="Nothing logged yet"
            hint="Tenant lifecycle changes and payment callbacks appear here." />
        ) : (
          <Table>
            <thead>
              <tr><Th>When</Th><Th>Actor</Th><Th>Action</Th><Th>Tenant</Th><Th>Details</Th></tr>
            </thead>
            <tbody>
              {filtered.map((l) => {
                const [verb] = l.action.split(':')
                return (
                  <tr key={l.id}>
                    <Td className="text-slate-400 font-mono whitespace-nowrap">
                      {new Date(l.created_at).toLocaleString()}
                    </Td>
                    <Td>
                      <p className="font-bold text-slate-800 dark:text-white">{l.actor_email ?? 'system'}</p>
                      {l.actor_role && <Badge value={l.actor_role} className="mt-0.5" />}
                    </Td>
                    <Td>
                      <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold font-mono ${ACTION_TONES[verb] ?? 'bg-slate-100 text-slate-600'}`}>
                        {l.action}
                      </span>
                    </Td>
                    <Td className="font-bold">{l.isp_name ?? '—'}</Td>
                    <Td className="text-slate-400 font-mono text-[10px]">
                      {Object.entries(l.metadata ?? {})
                        .map(([k, v]) => `${k}=${String(v)}`)
                        .join(' · ') || '—'}
                    </Td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  )
}