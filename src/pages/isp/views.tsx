/** Bridges the tenant context into the original ISP dashboard components. */
import { useState, type ReactNode } from 'react'
import { useTenant } from '../../context/TenantContext'
import { useTheme } from '../../context/ThemeContext'
import AdminDashboard from '../../components/AdminDashboard'
import Analytics from '../../components/Analytics'
import NetworkStatus from '../../components/NetworkStatus'
import MikrotikConfig from '../../components/MikrotikConfig'
import HotspotPortal from '../../components/HotspotPortal'
import ClientBilling from '../../components/ClientBilling'
import TermsAndConditions from '../../components/TermsAndConditions'
import { toClientProfile, toInvoice, toNode, toPlans, toSession, toTicket, toVoucher } from '../../lib/adapters'
import { startManualPayment } from '../../lib/data'
import type { ManualPaymentInstructions } from '../../lib/data'
import type { Ticket } from '../../lib/types'
import { Alert, Button, Card, Spinner } from '../../components/ui'

/** Shared loading + error gate for every tab. */
export function TenantGate({ children }: { children: ReactNode }) {
  const { loading, error, reload } = useTenant()
  if (loading) return <Spinner label="Loading tenant data…" />
  if (error) {
    return (
      <Card className="p-5 space-y-3">
        <Alert kind="error">{error}</Alert>
        <Button size="sm" onClick={() => void reload()}>Try again</Button>
      </Card>
    )
  }
  return <>{children}</>
}

// ── ISP Panel ────────────────────────────────────────────────────────────────
export function PanelView() {
  const { plans, vouchers, sessions, nodes, generateVouchers, clearExpiredVouchers, kickSession, setNodeStatus } = useTenant()

  return (
    <TenantGate>
      <AdminDashboard
        plans={toPlans(plans)}
        vouchers={vouchers.map((v) => toVoucher(v, plans))}
        sessions={sessions.map((s) => toSession(s, nodes))}
        nodes={nodes.map(toNode)}
        onBulkGenerateVouchers={(prefix, planId, count) => {
          void generateVouchers(planId, prefix, count)
        }}
        onClearExpiredVouchers={() => void clearExpiredVouchers()}
        onKickSession={(id) => void kickSession(id)}
        onToggleNodeStatus={(id) => void setNodeStatus(id, 'online')}
      />
    </TenantGate>
  )
}

// ── Analytics / Status / MikroTik / Legal ─────────────────────────────────────
export function AnalyticsView() {
  const { plans, vouchers, nodes } = useTenant()
  const { darkMode } = useTheme()
  return (
    <TenantGate>
      <Analytics vouchers={vouchers.map((v) => toVoucher(v, plans))} nodes={nodes.map(toNode)} darkMode={darkMode} />
    </TenantGate>
  )
}

export function StatusView() {
  const { nodes } = useTenant()
  return (
    <TenantGate>
      <NetworkStatus nodes={nodes} />
    </TenantGate>
  )
}

export function MikrotikView() {
  const { plans } = useTenant()
  const { darkMode } = useTheme()
  return (
    <TenantGate>
      <MikrotikConfig plans={toPlans(plans)} darkMode={darkMode} />
    </TenantGate>
  )
}

export function LegalView() {
  const { darkMode } = useTheme()
  const [tab, setTab] = useState<'terms' | 'privacy' | 'acceptable' | 'refund' | 'sla'>('terms')
  return (
    <TenantGate>
      <TermsAndConditions darkMode={darkMode} activeTab={tab} onTabChange={setTab} />
    </TenantGate>
  )
}

// ── Hotspot captive portal preview ────────────────────────────────────────────
export function HotspotView() {
  const { plans, vouchers, redeemVoucher, generateVouchers } = useTenant()
  const [connected, setConnected] = useState(false)
  const [code, setCode] = useState<string | null>(null)

  return (
    <TenantGate>
      <HotspotPortal
        plans={toPlans(plans)}
        vouchers={vouchers.map((v) => toVoucher(v, plans))}
        initialVoucherCode={code ?? ''}
        isConnected={connected}
        activeVoucherCode={code}
        onActivateVoucher={async (input: string) => {
          const res = await redeemVoucher(input)
          if (res.success) {
            setConnected(true)
            setCode(input.toUpperCase())
          }
          return res
        }}
        onDisconnect={() => { setConnected(false); setCode(null) }}
        onPurchaseVoucher={(plan) => {
          const match = plans.find((p) => p.name === plan.name)
          if (!match) return ''
          void generateVouchers(match.id, plan.name.slice(0, 4).toUpperCase(), 1)
            .then((v) => setCode(v[0]?.code ?? null))
          return ''
        }}
      />
    </TenantGate>
  )
}

// ── Billing portal ───────────────────────────────────────────────────────────
/**
 * Collection-mode switch.
 *
 * The default is the ACTIVE PROVIDER (PayHero), because that is what an ISP with an
 * automated channel configured wants and what a customer expects. The manual
 * option is kept, not deprecated: confirming a Till payment by hand is a real
 * administrative operation that no API replaces, and an ISP whose provider is not
 * configured yet still needs it.
 *
 * The two are labelled so they cannot be confused. "Manual / admin" is deliberate
 * wording: it tells the operator this is a human process, not a fallback that
 * happens when the provider is broken.
 */
export function BillingView() {
  const { clients, invoices, tickets, plans, messagesFor, payInvoice, addTicket, upgradePlan, reload } = useTenant()
  const [mode, setMode] = useState<'stk' | 'manual_till'>('stk')

  if (clients.length === 0) {
    return (
      <TenantGate>
        <Card className="p-8 text-center text-xs text-slate-500">
          No customers yet. Add one from the ISP Panel to use the billing portal.
        </Card>
      </TenantGate>
    )
  }

  return (
    <TenantGate>
      <div className="mb-4 flex flex-wrap items-center justify-end gap-2">
        <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mr-1">
          Collect via
        </span>
        <div className="inline-flex rounded-xl border border-slate-200 dark:border-slate-800 p-1 bg-white dark:bg-slate-900">
          <button
            onClick={() => setMode('stk')}
            className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition ${
              mode === 'stk'
                ? 'bg-violet-600 text-white'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-800'
            }`}
          >
            Online (M-Pesa)
          </button>
          <button
            onClick={() => setMode('manual_till')}
            className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition ${
              mode === 'manual_till'
                ? 'bg-emerald-600 text-white'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-800'
            }`}
          >
            Manual / admin
          </button>
        </div>
      </div>

      <BillingInner
        clients={clients} invoices={invoices} tickets={tickets}
        plans={plans} messagesFor={messagesFor}
        payInvoice={payInvoice} addTicket={addTicket}
        upgradePlan={upgradePlan} reload={reload}
        mode={mode} setMode={setMode}
      />
    </TenantGate>
  )
}

type Tenant = ReturnType<typeof useTenant>

function BillingInner(props: {
  clients: Tenant['clients']
  invoices: Tenant['invoices']
  tickets: Tenant['tickets']
  plans: Tenant['plans']
  messagesFor: Tenant['messagesFor']
  payInvoice: Tenant['payInvoice']
  addTicket: Tenant['addTicket']
  upgradePlan: Tenant['upgradePlan']
  reload: Tenant['reload']
  mode: 'stk' | 'manual_till'
  setMode: (m: 'stk' | 'manual_till') => void
}) {
  const { clients, invoices, tickets, plans, messagesFor, payInvoice, addTicket,
    upgradePlan, reload, mode, setMode } = props
  const [selected, setSelected] = useState<string>(clients[0].id)
  const [uiTickets, setUiTickets] = useState(() => tickets.map((t) => toTicket(t, [])))
  const [instructions, setInstructions] = useState<ManualPaymentInstructions | null>(null)
  const [payError, setPayError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  const active = clients.find((c) => c.id === selected) ?? clients[0]
  const uiInvoices = invoices.filter((i) => i.client_id === active.id).map(toInvoice)
  const unpaid = uiInvoices.filter((i) => i.status === 'Unpaid' || i.status === 'Overdue')

  async function beginManualPay(invoiceNo: string) {
    const raw = invoices.find((i) => i.invoice_no === invoiceNo)
    if (!raw) return
    setStarting(true)
    setPayError(null)
    try {
      setInstructions(await startManualPayment(raw.id, active.phone))
    } catch (err) {
      setPayError((err as Error).message)
    } finally {
      setStarting(false)
    }
  }

return (
    <TenantGate>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
          Billing as
        </span>
        <select
          value={active.id}
          onChange={(e) => { setSelected(e.target.value); setInstructions(null); setPayError(null) }}
          className="rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs"
        >
          {clients.map((c) => (
            <option key={c.id} value={c.id}>{c.full_name} — {c.account_no}</option>
          ))}
        </select>
      </div>

      {mode === 'manual_till' && (
        <Card className="p-5 mb-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-black text-slate-900 dark:text-white">
                Manual / admin payment
              </h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                The customer pays your Till by hand and staff confirm it. Use this for
                cash and offline payments; online M-Pesa is the default above.
              </p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => setMode('stk')}>
              Use online M-Pesa
            </Button>
          </div>

          {payError && <Alert kind="error">{payError}</Alert>}

          {instructions ? (
            <div className="rounded-xl border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 p-4 space-y-3">
              <p className="text-xs font-bold text-emerald-900 dark:text-emerald-200">
                Instructions issued — waiting for the customer to pay
              </p>
              <div className="grid grid-cols-3 gap-3">
                {([
                  ['Amount', `KES ${Number(instructions.amount).toLocaleString()}`],
                  ['Reference', instructions.reference],
                  ['Till number', instructions.tillNumber ?? '—'],
                ] as const).map(([k, v]) => (
                  <div key={k}>
                    <p className="text-[10px] uppercase tracking-wide text-emerald-700/70 dark:text-emerald-300/70 font-mono">
                      {k}
                    </p>
                    <p className="text-sm font-black text-emerald-900 dark:text-emerald-100 font-mono break-all">
                      {v}
                    </p>
                  </div>
                ))}
              </div>
              <ol className="text-[11px] text-emerald-900/80 dark:text-emerald-200/80 space-y-1 list-decimal list-inside">
                {instructions.instructions.map((s) => <li key={s}>{s}</li>)}
              </ol>
              {instructions.notice && (
                <p className="text-[11px] italic text-emerald-800 dark:text-emerald-300">{instructions.notice}</p>
              )}
            </div>
          ) : unpaid.length === 0 ? (
            <p className="text-xs text-slate-500">No outstanding invoices for this customer.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {unpaid.map((inv) => (
                <button
                  key={inv.id}
                  disabled={starting}
                  onClick={() => void beginManualPay(inv.id)}
                  className="text-left rounded-xl border border-slate-200 dark:border-slate-800 px-3 py-2.5 hover:border-emerald-400 transition disabled:opacity-50"
                >
                  <p className="text-[10px] font-mono text-slate-400">{inv.id}</p>
                  <p className="text-sm font-black text-slate-900 dark:text-white">
                    KES {inv.amount.toLocaleString()}
                  </p>
                  <p className="text-[10px] text-slate-500">{inv.billingMonth}</p>
                </button>
              ))}
            </div>
          )}
        </Card>
      )}

      <ClientBilling
        client={toClientProfile(active)}
        invoices={uiInvoices}
        tickets={uiTickets}
        plans={toPlans(plans)}
        darkMode={false}
        onPayInvoice={async (invoiceId: string) => {
          if (mode === 'manual_till') {
            await beginManualPay(invoiceId)
            return
          }
          const raw = invoices.find((i) => i.invoice_no === invoiceId)
          const ui = uiInvoices.find((i) => i.id === invoiceId)
          if (!raw || !ui) return
          await payInvoice({
            invoiceId: raw.id, phone: active.phone, amount: ui.amount, clientId: active.id,
          })
        }}
        onAddTicket={async (
          subject: string,
          category: 'Speed Issue' | 'Payment Failed' | 'Router Offline' | 'Voucher Code Error',
          priority: 'Low' | 'Medium' | 'High',
        ) => {
          await addTicket(subject, category, priority.toLowerCase() as Ticket['priority'], active.id)
          await reload()
          const fresh = await Promise.all(
            tickets.slice(0, 6).map(async (t) => toTicket(t, await messagesFor(t.id))),
          )
          setUiTickets(fresh)
        }}
        onUpgradePlan={(planName: string) => void upgradePlan(active.id, planName)}
      />
    </TenantGate>
  )
}