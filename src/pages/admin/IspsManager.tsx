import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  Plus, Search, Building2, PauseCircle, PlayCircle, Trash2, ArrowUpRight, X,
} from 'lucide-react'
import { createIsp, deleteIsp, fetchIspStats, setIspStatus } from '../../lib/data'
import type { IspPlan, IspStats, IspStatus } from '../../lib/types'
import { cn } from '../../utils/cn'
import {
  Alert, Badge, Button, Card, Field, Spinner, Table, Td, Th, inputClass,
} from '../../components/ui'

const PLAN_LIMITS: Record<IspPlan, { maxClients: number; maxPlans: number; maxNodes: number }> = {
  starter: { maxClients: 100, maxPlans: 5, maxNodes: 3 },
  growth: { maxClients: 500, maxPlans: 10, maxNodes: 6 },
  enterprise: { maxClients: 5000, maxPlans: 50, maxNodes: 25 },
}

const STATUS_FILTERS: Array<IspStatus | 'all'> = ['all', 'trial', 'active', 'suspended', 'churned']

export default function IspsManager() {
  const [isps, setIsps] = useState<IspStats[] | null>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<IspStatus | 'all'>('all')
  const [showCreate, setShowCreate] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)

  const load = useCallback(() => {
    fetchIspStats().then(setIsps).catch((e: Error) =>
      setNotice({ kind: 'error', text: e.message }))
  }, [])

  useEffect(load, [load])

  const filtered = useMemo(() => {
    const list = isps ?? []
    const q = query.trim().toLowerCase()
    return list.filter((i) =>
      (status === 'all' || i.status === status)
      && (!q || i.name.toLowerCase().includes(q) || i.slug.includes(q) || i.city?.toLowerCase().includes(q)),
    )
  }, [isps, query, status])

  async function run(action: () => Promise<unknown>, successText: string) {
    setBusy(true)
    setNotice(null)
    try {
      await action()
      setNotice({ kind: 'success', text: successText })
      load()
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Action failed.' })
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(isp: IspStats) {
    if (!confirm(
      `Permanently delete ${isp.name}?\n\nThis wipes every customer, invoice, voucher and node belonging to them. This cannot be undone.`,
    )) return
    await run(() => deleteIsp(isp.id), `${isp.name} has been deleted.`)
  }

  if (!isps) return <Spinner label="Loading tenants…" />

return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">ISPs</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Provision, activate, suspend or remove tenants on this platform.
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)} icon={<Plus className="w-4 h-4" />}>New ISP</Button>
      </div>

      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}

      <Card>
        <div className="p-4 flex flex-wrap items-center gap-3 border-b border-slate-200 dark:border-slate-800">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, subdomain or city…"
              className={cn(inputClass, 'pl-9')}
            />
          </div>
          <div className="flex gap-1 p-1 rounded-xl bg-slate-100 dark:bg-slate-800">
            {STATUS_FILTERS.map((s) => (
              <button
                key={s}
                onClick={() => setStatus(s)}
                className={cn(
                  'px-2.5 py-1.5 rounded-lg text-[11px] font-bold capitalize transition',
                  status === s
                    ? 'bg-white dark:bg-slate-700 text-violet-600 dark:text-violet-300 shadow-sm'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-700',
                )}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="p-6 text-center text-xs text-slate-500">No ISPs match that filter.</div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>ISP</Th><Th>Status</Th><Th>Plan</Th><Th>Customers</Th>
                <Th>Revenue 30d</Th><Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((i) => (
                <tr key={i.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition">
                  <Td>
                    <div className="flex items-center gap-2.5">
                      <span
                        className="w-8 h-8 rounded-lg grid place-items-center text-white text-[10px] font-black shrink-0"
                        style={{ backgroundColor: i.brand_color }}
                      >
                        {i.name.slice(0, 2).toUpperCase()}
                      </span>
                      <Link to={`/admin/isps/${i.id}`} className="min-w-0 group">
                        <p className="font-bold text-slate-800 dark:text-white truncate group-hover:text-violet-600 transition">
                          {i.name}
                        </p>
                        <p className="text-[10px] text-slate-400 font-mono truncate">
                          {i.slug}.portal · {i.city ?? '—'}
                        </p>
                      </Link>
                    </div>
                  </Td>
                  <Td><Badge value={i.status} /></Td>
                  <Td><Badge value={i.plan} /></Td>
                  <Td className="font-mono">
                    {i.active_clients}<span className="text-slate-400"> / {i.max_clients}</span>
                  </Td>
                  <Td className="font-mono font-bold">
                    KES {Number(i.revenue_30d).toLocaleString('en', { maximumFractionDigits: 0 })}
                  </Td>
                  <Td className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Link to={`/admin/isps/${i.id}`} title="Open details">
                        <ArrowUpRight className="w-4 h-4 text-slate-400 hover:text-violet-600" />
                      </Link>
                      {i.status === 'suspended' ? (
                        <button
                          title="Reactivate" disabled={busy}
                          onClick={() => run(() => setIspStatus(i.id, 'active'), `${i.name} reactivated.`)}
                          className="p-1.5 rounded-lg text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 disabled:opacity-40"
                        >
                          <PlayCircle className="w-4 h-4" />
                        </button>
                      ) : (
                        <button
                          title="Suspend" disabled={busy}
                          onClick={() => run(() => setIspStatus(i.id, 'suspended'), `${i.name} suspended.`)}
                          className="p-1.5 rounded-lg text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-500/10 disabled:opacity-40"
                        >
                          <PauseCircle className="w-4 h-4" />
                        </button>
                      )}
                      <button
                        title="Delete permanently" disabled={busy} onClick={() => handleDelete(i)}
                        className="p-1.5 rounded-lg text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10 disabled:opacity-40"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {showCreate && (
        <CreateIspModal
          busy={busy}
          onClose={() => setShowCreate(false)}
          onSubmit={async (input) => {
            await run(() => createIsp(input), `${input.name} created. A 14-day trial is now running.`)
            setShowCreate(false)
          }}
        />
      )}
    </div>
  )
}

function CreateIspModal({
  onClose, onSubmit, busy,
}: {
  onClose: () => void
  onSubmit: (input: {
    name: string; slug: string; phone: string; county: string; city: string
    plan: IspPlan; maxClients: number; maxPlans: number; maxNodes: number
  }) => Promise<void>
  busy: boolean
}) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [phone, setPhone] = useState('')
  const [county, setCounty] = useState('Nairobi')
  const [city, setCity] = useState('Nairobi')
  const [plan, setPlan] = useState<IspPlan>('starter')
  const [error, setError] = useState<string | null>(null)
  const [slugTouched, setSlugTouched] = useState(false)

  const limits = PLAN_LIMITS[plan]

  // Auto-derive the subdomain from the name until the user types their own.
  const effectiveSlug = slugTouched
    ? slug
    : name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      await onSubmit({ name, slug: effectiveSlug, phone, county, city, plan, ...limits })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the ISP.')
    }
  }

  return (
    <Modal title="Create a new ISP" icon={<Building2 className="w-4 h-4" />} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert kind="error">{error}</Alert>}

        <Field label="ISP name">
          <input required value={name} onChange={(e) => setName(e.target.value)}
            className={inputClass} placeholder="Coastal Link Ltd" />
        </Field>

        <Field label="Portal subdomain" hint={`Captive portal: /portal/${effectiveSlug || 'your-isp'}`}>
          <input
            required minLength={3} value={effectiveSlug}
            onChange={(e) => { setSlugTouched(true); setSlug(e.target.value.toLowerCase()) }}
            className={inputClass} placeholder="coastal-link"
          />
        </Field>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Phone">
            <input required value={phone} onChange={(e) => setPhone(e.target.value)}
              className={inputClass} placeholder="07XXXXXXXX" />
          </Field>
          <Field label="City">
            <input required value={city} onChange={(e) => setCity(e.target.value)} className={inputClass} />
          </Field>
          <Field label="County">
            <input required value={county} onChange={(e) => setCounty(e.target.value)} className={inputClass} />
          </Field>
        </div>

        <Field
          group
          label="Plan tier"
          hint={`${limits.maxClients} customers · ${limits.maxPlans} plans · ${limits.maxNodes} nodes`}
        >
          <div className="grid grid-cols-3 gap-2">
            {(['starter', 'growth', 'enterprise'] as IspPlan[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPlan(p)}
                className={cn(
                  'rounded-xl border px-3 py-2.5 text-[11px] font-bold capitalize transition',
                  plan === p
                    ? 'border-violet-500 bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300'
                    : 'border-slate-300 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-slate-400',
                )}
              >
                {p}
              </button>
            ))}
          </div>
        </Field>

        <div className="flex gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose} className="flex-1">Cancel</Button>
          <Button type="submit" loading={busy} className="flex-1" icon={<Plus className="w-4 h-4" />}>
            Create ISP
          </Button>
        </div>
      </form>
    </Modal>
  )
}

export function Modal({
  title, icon, onClose, children, wide,
}: {
  title: string; icon?: ReactNode; onClose: () => void
  children: ReactNode; wide?: boolean
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
      <div
        className={cn(
          'w-full bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800',
          'max-h-[90vh] overflow-y-auto',
          wide ? 'max-w-3xl' : 'max-w-lg',
        )}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800 sticky top-0 bg-white dark:bg-slate-900 z-10">
          <h3 className="flex items-center gap-2 text-sm font-black tracking-tight text-slate-900 dark:text-white">
            {icon && <span className="text-violet-600 dark:text-violet-400">{icon}</span>}
            {title}
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 dark:hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  )
}