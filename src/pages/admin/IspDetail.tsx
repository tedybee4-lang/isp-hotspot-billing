import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ArrowLeft, Building2, Users, Radio, Wallet, SlidersHorizontal,
  UserPlus, PauseCircle, PlayCircle, CreditCard, Trash2, Globe,
} from 'lucide-react'
import {
  deleteIsp, fetchIspStats, fetchTenantStaff, inviteStaff,
  setIspPlan, setIspStatus, fetchPaymentConfig, updatePaymentConfig,
} from '../../lib/data'
import type { PaymentConfigStatus } from '../../lib/data'
import type { IspPlan, IspStats, Profile } from '../../lib/types'
import { Modal } from './IspsManager'
import { cn } from '../../utils/cn'
import {
  Alert, Badge, Button, Card, CardHeader, Field, Spinner,
  StatTile, Table, Td, Th, inputClass,
} from '../../components/ui'

const money = (n: number) => n.toLocaleString('en', { maximumFractionDigits: 0 })

export default function IspDetail() {
  const { id } = useParams<{ id: string }>()
  const [isp, setIsp] = useState<IspStats | null>(null)
  const [staff, setStaff] = useState<Profile[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [inviting, setInviting] = useState(false)

  const load = useCallback(async () => {
    if (!id) return
    try {
      const all = await fetchIspStats()
      setIsp(all.find((i) => i.id === id) ?? null)
      setStaff(await fetchTenantStaff(id))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [id])

  useEffect(() => { void load() }, [load])

  async function run(action: () => Promise<unknown>, successText: string) {
    setBusy(true)
    setNotice(null)
    try {
      await action()
      setNotice({ kind: 'success', text: successText })
      await load()
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Action failed.' })
    } finally {
      setBusy(false)
    }
  }

  if (error) return <Card className="p-6"><p className="text-sm font-bold text-rose-600">{error}</p></Card>
  if (!isp) return <Spinner label="Loading tenant…" />

  const trialDaysLeft = isp.trial_ends_at
    ? Math.ceil((new Date(isp.trial_ends_at).getTime() - Date.now()) / 864e5)
    : null

return (
    <div className="space-y-6">
      <Link
        to="/admin/isps"
        className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 dark:text-slate-400 hover:text-violet-600 transition"
      >
        <ArrowLeft className="w-3.5 h-3.5" /> Back to ISPs
      </Link>

      <Card className="overflow-hidden">
        <div className="h-20" style={{ backgroundColor: isp.brand_color }} />
        <div className="px-5 pb-5">
          {/* The avatar is pulled up into the banner with a negative bottom margin;
              the text stays below it so it never renders dark-on-colour. */}
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex items-end gap-3">
              <span
                className="w-14 h-14 rounded-2xl grid place-items-center text-white text-lg font-black shadow-lg ring-4 ring-white dark:ring-slate-900 shrink-0 -mb-7"
                style={{ backgroundColor: isp.brand_color }}
              >
                {isp.name.slice(0, 2).toUpperCase()}
              </span>
              <div>
                <h1 className="text-xl font-black tracking-tight text-slate-900 dark:text-white">
                  {isp.name}
                </h1>
                <p className="text-[11px] text-slate-400 font-mono">
                  /portal/{isp.slug} · joined {new Date(isp.created_at).toLocaleDateString()}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Badge value={isp.status} />
              <Badge value={isp.plan} />
              {trialDaysLeft != null && trialDaysLeft > 0 && (
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300">
                  {trialDaysLeft}d trial left
                </span>
              )}
              <Button size="sm" variant="secondary" onClick={() => setEditing(true)}
                icon={<SlidersHorizontal className="w-3.5 h-3.5" />}>
                Limits
              </Button>
              {isp.status === 'suspended' ? (
                <Button size="sm" variant="success" disabled={busy}
                  onClick={() => run(() => setIspStatus(isp.id, 'active'), 'Tenant reactivated.')}
                  icon={<PlayCircle className="w-3.5 h-3.5" />}>
                  Reactivate
                </Button>
              ) : (
                <Button size="sm" variant="secondary" disabled={busy}
                  onClick={() => run(() => setIspStatus(isp.id, 'suspended'), 'Tenant suspended.')}
                  icon={<PauseCircle className="w-3.5 h-3.5" />}>
                  Suspend
                </Button>
              )}
            </div>
          </div>

          {isp.status === 'suspended' && (
            <div className="mt-4">
              <Alert kind="error">
                This ISP is suspended. Their staff can still sign in, but all tenant data is
                frozen until you reactivate it.
              </Alert>
            </div>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatTile
          label="Customers" value={`${isp.active_clients} / ${isp.max_clients}`}
          icon={<Users className="w-5 h-5" />} tone="sky" hint={`${isp.total_clients} total records`}
        />
        <StatTile label="Nodes online" value={isp.nodes_online} icon={<Radio className="w-5 h-5" />} tone="emerald" />
        <StatTile
          label="Revenue (30d)" value={`KES ${money(Number(isp.revenue_30d))}`}
          icon={<Wallet className="w-5 h-5" />} tone="violet"
        />
        <StatTile
          label="Outstanding" value={`KES ${money(Number(isp.outstanding))}`}
          icon={<CreditCard className="w-5 h-5" />} tone="amber"
        />
      </div>

      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}

<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader title="Tenant record" subtitle="Registered details" icon={<Building2 className="w-4 h-4" />} />
          <div className="p-5 space-y-3 text-xs">
            {([
              ['Contact email', isp.contact_email],
              ['Phone', isp.contact_phone ?? '—'],
              ['Location', [isp.city, isp.county, isp.country].filter(Boolean).join(', ')],
              ['Portal subdomain', `${isp.slug}.portal`],
              ['Onboarded', isp.onboarded_at ? new Date(isp.onboarded_at).toLocaleDateString() : 'Not yet'],
              ['Last payment', isp.last_payment_at ? new Date(isp.last_payment_at).toLocaleString() : 'Never'],
            ] as const).map(([label, value]) => (
              <div key={label} className="flex items-start justify-between gap-4">
                <span className="text-slate-400 shrink-0">{label}</span>
                <span className="font-bold text-slate-700 dark:text-slate-200 text-right break-all">
                  {value}
                </span>
              </div>
            ))}
            <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
              <Link
                to={`/portal/${isp.slug}`}
                className="inline-flex items-center gap-1.5 text-[11px] font-bold text-violet-600 dark:text-violet-400 hover:underline"
              >
                <Globe className="w-3.5 h-3.5" /> Preview their captive portal
              </Link>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Plan limits" subtitle="Usage against the tier caps" icon={<SlidersHorizontal className="w-4 h-4" />} />
          <div className="p-5 space-y-4">
            {([
              ['Customers', isp.active_clients, isp.max_clients],
              ['Plans', isp.plan_count, isp.max_plans],
              ['Nodes', isp.nodes_online, isp.max_nodes],
            ] as const).map(([label, used, cap]) => {
              const pct = Math.min(100, (used / (cap || 1)) * 100)
              const tight = pct >= 90
              return (
                <div key={label}>
                  <div className="flex justify-between text-[11px] mb-1">
                    <span className="font-bold text-slate-600 dark:text-slate-300">{label}</span>
                    <span className={cn('font-mono', tight ? 'text-rose-600 font-bold' : 'text-slate-400')}>
                      {used} / {cap}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                    <div
                      className={cn('h-full rounded-full transition-all',
                        tight ? 'bg-rose-500' : pct > 70 ? 'bg-amber-500' : 'bg-emerald-500')}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              )
            })}
            <p className="text-[10px] text-slate-400 leading-relaxed pt-1">
              Caps are enforced in Postgres — voucher generation and customer creation both
              fail once the tenant hits its limit.
            </p>
          </div>
        </Card>
      </div>

      <MpesaCard ispId={isp.id} onSaved={() => setNotice({ kind: 'success', text: 'M-Pesa configuration saved.' })} />

      <Card>
        <CardHeader
          title="Team"
          subtitle={`${staff.length} user${staff.length === 1 ? '' : 's'} with access`}
          icon={<Users className="w-4 h-4" />}
          action={<Button size="sm" onClick={() => setInviting(true)} icon={<UserPlus className="w-3.5 h-3.5" />}>Add user</Button>}
        />
        <Table>
          <thead>
            <tr><Th>User</Th><Th>Role</Th><Th>Phone</Th><Th>Status</Th></tr>
          </thead>
          <tbody>
            {staff.map((s) => (
              <tr key={s.id}>
                <Td>
                  <p className="font-bold text-slate-800 dark:text-white">{s.full_name ?? '—'}</p>
                  <p className="text-[10px] text-slate-400 font-mono">{s.id.slice(0, 18)}…</p>
                </Td>
                <Td><Badge value={s.role} /></Td>
                <Td className="font-mono text-slate-400">{s.phone ?? '—'}</Td>
                <Td><Badge value={s.is_active ? 'active' : 'suspended'} /></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Card className="border-rose-200 dark:border-rose-500/30">
        <CardHeader title="Danger zone" subtitle="Irreversible actions" icon={<Trash2 className="w-4 h-4 text-rose-500" />} />
        <div className="p-5 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-slate-500 dark:text-slate-400 max-w-lg">
            Deleting this tenant permanently removes all of its customers, invoices,
            payments, vouchers, nodes and support tickets.
          </p>
          <Button
            variant="danger" disabled={busy}
            onClick={() => {
              if (!confirm(`Permanently delete ${isp.name} and all of its data?`)) return
              void run(() => deleteIsp(isp.id), `${isp.name} deleted.`)
            }}
          >
            Delete tenant
          </Button>
        </div>
      </Card>

      {editing && (
        <LimitsModal
          isp={isp} busy={busy}
          onClose={() => setEditing(false)}
          onSave={(plan, mc, mp, mn) =>
            run(() => setIspPlan(isp.id, plan, mc, mp, mn), 'Limits updated.')
              .then(() => setEditing(false))}
        />
      )}

      {inviting && (
        <InviteModal
          isp={isp}
          onClose={() => setInviting(false)}
          onInvite={(input) =>
            run(() => inviteStaff(input), `${input.fullName} added to ${isp.name}.`)
              .then(() => setInviting(false))}
        />
      )}
    </div>
  )
}

/**
 * Per-tenant payment collection.
 *
 * This card collects the Till / PayBill numbers a customer pays to by hand, and
 * the message shown on the payment instruction screen.
 *
 * It deliberately holds no provider credentials. Automated M-Pesa is HashBack,
 * and each tenant links its own HashBack channel under /app/settings/payments;
 * the platform's API key and webhook secret live only in the Edge Function
 * environment and the encrypted store. The Safaricom consumer key / secret /
 * passkey form that used to live here was removed with the Daraja cutover.
 */
function MpesaCard({ ispId, onSaved }: { ispId: string; onSaved: () => void }) {
  const [cfg, setCfg] = useState<PaymentConfigStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [till, setTill] = useState('')
  const [paybill, setPaybill] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const next = await fetchPaymentConfig(ispId)
        if (cancelled) return
        setCfg(next)
        setTill(next.till_number ?? '')
        setPaybill(next.paybill_number ?? '')
        setNotice(next.customer_notice ?? '')
      } catch (err) {
        if (!cancelled) setLoadError((err as Error).message)
      }
    })()
    return () => { cancelled = true }
  }, [ispId])

  async function save() {
    setSaving(true)
    setError(null)
    try {
      await updatePaymentConfig(ispId, {
        payment_mode: 'manual_till',
        till_number: till,
        paybill_number: paybill,
        customer_notice: notice,
      })
      setCfg(await fetchPaymentConfig(ispId))
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (loadError) {
    return (
      <Card>
        <CardHeader title="Payment collection" icon={<CreditCard className="w-4 h-4" />} />
        <div className="p-5"><Alert kind="error">{loadError}</Alert></div>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader
        title="Payment collection"
        subtitle="The Till / PayBill numbers this ISP collects on by hand."
        icon={<CreditCard className="w-4 h-4" />}
        action={<Badge value={cfg?.ready ? 'ready' : 'not_configured'} />}
      />
      <div className="p-5 space-y-4">
        {error && <Alert kind="error">{error}</Alert>}

        {!cfg?.ready && (
          <Alert kind="success">
            Add at least a Till or Paybill number. Customers then pay from the M-Pesa
            app or *334#, and staff confirm the payment to settle the invoice.
          </Alert>
        )}

        <Alert kind="info">
          Automated M-Pesa payments run through <strong>HashBack</strong>. The ISP links
          its own HashBack channel under <strong>Settings &rarr; Payments</strong>. There is
          no Safaricom Daraja account to configure: that path was removed.
        </Alert>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Till number" hint="The number customers send money to.">
            <input value={till} onChange={(e) => setTill(e.target.value)}
              className={`${inputClass} font-mono`} placeholder="522533" />
          </Field>
          <Field label="Paybill number" hint="Optional alternative.">
            <input value={paybill} onChange={(e) => setPaybill(e.target.value)}
              className={`${inputClass} font-mono`} placeholder="174379" />
          </Field>
        </div>

        <Field label="Message to customers" hint="Shown on the payment instruction screen.">
          <textarea value={notice} rows={2} onChange={(e) => setNotice(e.target.value)}
            className={`${inputClass} resize-none`}
            placeholder="Pay the exact amount so your account is credited automatically." />
        </Field>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button loading={saving} onClick={save} icon={<CreditCard className="w-4 h-4" />}>
            Save payment settings
          </Button>
          <span className="text-[10px] text-slate-400 font-mono">
            stored in isp_payment_configs
          </span>
        </div>
      </div>
    </Card>
  )
}

const TIERS: Record<IspPlan, { maxClients: number; maxPlans: number; maxNodes: number }> = {
  starter: { maxClients: 100, maxPlans: 5, maxNodes: 3 },
  growth: { maxClients: 500, maxPlans: 10, maxNodes: 6 },
  enterprise: { maxClients: 5000, maxPlans: 50, maxNodes: 25 },
}

function LimitsModal({
  isp, busy, onClose, onSave,
}: {
  isp: IspStats; busy: boolean; onClose: () => void
  onSave: (plan: IspPlan, maxClients: number, maxPlans: number, maxNodes: number) => void
}) {
  const [plan, setPlan] = useState<IspPlan>(isp.plan)
  const [maxClients, setMaxClients] = useState(isp.max_clients)
  const [maxPlans, setMaxPlans] = useState(isp.max_plans)
  const [maxNodes, setMaxNodes] = useState(isp.max_nodes)

  function pickTier(p: IspPlan) {
    setPlan(p)
    setMaxClients(TIERS[p].maxClients)
    setMaxPlans(TIERS[p].maxPlans)
    setMaxNodes(TIERS[p].maxNodes)
  }

  return (
    <Modal title="Plan tier & limits" icon={<SlidersHorizontal className="w-4 h-4" />} onClose={onClose}>
      <div className="space-y-4">
        <Field
          group
          label="Commercial tier"
        >
          <div className="grid grid-cols-3 gap-2">
            {(Object.keys(TIERS) as IspPlan[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => pickTier(p)}
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

        <div className="grid grid-cols-3 gap-3">
          <Field label="Max customers">
            <input type="number" min={isp.active_clients} value={maxClients}
              onChange={(e) => setMaxClients(Number(e.target.value))} className={inputClass} />
          </Field>
          <Field label="Max plans">
            <input type="number" min={isp.plan_count} value={maxPlans}
              onChange={(e) => setMaxPlans(Number(e.target.value))} className={inputClass} />
          </Field>
          <Field label="Max nodes">
            <input type="number" min={1} value={maxNodes}
              onChange={(e) => setMaxNodes(Number(e.target.value))} className={inputClass} />
          </Field>
        </div>

        <Alert kind="success">
          Lowering a limit below what the tenant already uses will block new customers and
          vouchers until they get back under the cap.
        </Alert>

        <div className="flex gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} className="flex-1">Cancel</Button>
          <Button loading={busy} className="flex-1"
            onClick={() => onSave(plan, maxClients, maxPlans, maxNodes)}>
            Save limits
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function InviteModal({
  isp, onClose, onInvite,
}: {
  isp: IspStats; onClose: () => void
  onInvite: (input: {
    ispId: string; email: string; password: string
    fullName: string; role: Profile['role']
  }) => Promise<void>
}) {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<'isp_admin' | 'isp_agent'>('isp_agent')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await onInvite({ ispId: isp.id, fullName, email, password, role })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the user.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`Add a user to ${isp.name}`} icon={<UserPlus className="w-4 h-4" />} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert kind="error">{error}</Alert>}

        <Field label="Full name">
          <input required value={fullName} onChange={(e) => setFullName(e.target.value)}
            className={inputClass} placeholder="Samuel Otieno" />
        </Field>

        <Field label="Email">
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
            className={inputClass} placeholder={`samuel@${isp.slug}.co.ke`} />
        </Field>

        <Field label="Temporary password" hint="At least 8 characters. Share it securely.">
          <input type="text" required minLength={8} value={password}
            onChange={(e) => setPassword(e.target.value)} className={inputClass} />
        </Field>

        <Field group label="Role">
          <div className="grid grid-cols-2 gap-2">
            {([
              ['isp_admin', 'Admin — full access'],
              ['isp_agent', 'Agent — support only'],
            ] as const).map(([r, label]) => (
              <button
                key={r}
                type="button"
                onClick={() => setRole(r)}
                className={cn(
                  'rounded-xl border px-3 py-2.5 text-[11px] font-bold transition text-left',
                  role === r
                    ? 'border-violet-500 bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300'
                    : 'border-slate-300 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-slate-400',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </Field>

        <div className="flex gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose} className="flex-1">Cancel</Button>
          <Button type="submit" loading={busy} className="flex-1">Add user</Button>
        </div>
      </form>
    </Modal>
  )
}