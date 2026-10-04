/**
 * Payment settings, network settings and SMS settings.
 *
 * The tenant's Till / PayBill numbers are its own. Platform Daraja credentials
 * are deliberately absent from this screen: they live server-side and are never
 * sent to a browser.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Save, CreditCard, Globe, MessageSquare, ShieldCheck, Lock,
} from 'lucide-react'
import * as api from '../../../lib/data'
import type { NetworkSettings, SmsSettings, TillSettings } from '../../../lib/data'
import { fetchMyPaymentChannel, type MyPaymentChannel } from '../../../lib/payments'
import { isAutomatedProvider, providerLabel } from '../../../lib/provider'
import { config } from '../../../lib/config'
import {
  Card, CardHeader, Button, Field, Alert, Spinner, inputClass, Badge,
} from '../../../components/ui'

function useResource<T>(load: () => Promise<T | null>, save: (v: T) => Promise<void>) {
  const [value, setValue] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setValue(await load())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load settings.')
    } finally {
      setLoading(false)
    }
  }, [load])

  useEffect(() => { void refresh() }, [refresh])

  async function persist(next: T) {
    setBusy(true); setError(null); setNotice(null)
    try {
      await save(next)
      setValue(next)
      setNotice('Saved.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.')
    } finally {
      setBusy(false)
    }
  }

  return { value, setValue, loading, busy, error, notice, persist, refresh }
}

export function PaymentSettingsPage() {
  const till = useResource<TillSettings | null>(api.fetchTillSettings,
    async (v) => api.saveTillSettings({ till: v?.till_number ?? '', paybill: v?.paybill_number ?? '' }))
  const [number, setNumber] = useState('')
  const [paybill, setPaybill] = useState('')

  useEffect(() => {
    if (till.value) {
      setNumber(till.value.till_number ?? '')
      setPaybill(till.value.paybill_number ?? '')
    }
  }, [till.value])

  if (till.loading) return <Spinner label="Loading payment settings..." />

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-black tracking-tight text-slate-900 dark:text-white">
          Payment Settings
        </h1>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
          Who collects your money, and your own Till and PayBill numbers.
        </p>
      </div>

      {till.error && <Alert kind="error">{till.error}</Alert>}
      {till.notice && <Alert kind="success">{till.notice}</Alert>}

      {config.mode !== 'live' && (
        <Alert kind="info">
          Demo mode: nothing is sent to a payment provider.
        </Alert>
      )}

      {/* The provider an ISP actually collects through, read from this tenant's own
          server-resolved configuration. `fetchMyPaymentChannel()` takes no ISP id, so
          this can only ever show this tenant's data. */}
      <ProviderStatusCard />

      <Card>
        <CardHeader
          title="Manual / admin Till numbers"
          subtitle="Used when staff confirm a payment by hand, or while no automated channel is assigned"
          icon={<CreditCard className="w-4 h-4" />}
        />
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Till number" hint="Customers pay to this Till">
              <input className={inputClass} value={number} inputMode="numeric"
                onChange={(e) => setNumber(e.target.value)} placeholder="522533" />
            </Field>
            <Field label="PayBill number" hint="Optional, if you also have a PayBill">
              <input className={inputClass} value={paybill} inputMode="numeric"
                onChange={(e) => setPaybill(e.target.value)} placeholder="247200" />
            </Field>
          </div>
          <Button size="sm" disabled={till.busy} icon={<Save className="w-3.5 h-3.5" />}
            onClick={() => void till.persist({ ...(till.value as TillSettings), till_number: number || null, paybill_number: paybill || null } as TillSettings)}>
            {till.busy ? 'Saving...' : 'Save Till details'}
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader title="Security" icon={<ShieldCheck className="w-4 h-4" />} />
        <div className="p-5">
          <div className="flex items-start gap-3">
            <Lock className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
              The PayHero API token is held server-side and encrypted. It is never sent
              to your browser and cannot be read from this page. You only ever see the
              payment channel assigned to you, which identifies where your money goes
              but cannot authorise anything against PayHero.
            </p>
          </div>
        </div>
      </Card>
    </div>
  )
}

/**
 * Shows this ISP's active payment provider and channel.
 *
 * Read-only by design. The ISP does not choose its provider or channel: the platform
 * connects PayHero once and assigns a channel, because a channel may only back one
 * tenant and an ISP picking its own would let two ISPs share a Till.
 */
function ProviderStatusCard() {
  const [channel, setChannel] = useState<MyPaymentChannel | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchMyPaymentChannel()
      .then((c) => { if (!cancelled) setChannel(c) })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  if (loading) return <Spinner label="Reading your payment provider..." />
  if (error) return <Alert kind="error">{error}</Alert>

  const provider = providerLabel(channel?.payment_provider)
  const automated = isAutomatedProvider(channel?.payment_provider)
  const connected = channel?.connection_status === 'connected'

  return (
    <Card>
      <CardHeader
        title="Payment provider"
        subtitle="Assigned by the platform. You do not need to configure it."
        icon={<ShieldCheck className="w-4 h-4" />}
      />
      <div className="p-5 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-bold text-slate-900 dark:text-white">{provider}</span>
          {automated ? (
            <Badge value={connected ? 'CONNECTED ✓' : 'NOT CONNECTED'} className={connected ? 'emerald' : 'amber'} />
          ) : (
            // Manual is a legitimate mode, not a failure state, so it is not
            // coloured as a warning.
            <Badge value="MANUAL / ADMIN" className="slate" />
          )}
        </div>

        {automated ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {connected
              ? 'Customers pay by M-Pesa prompt. Your package activates once the payment is confirmed.'
              : 'The platform has not assigned a working payment channel to you yet. Customers cannot pay online until it does.'}
          </p>
        ) : (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            You collect by hand. Staff issue instructions and confirm the payment against
            the Till statement.
          </p>
        )}

        {/* The channel label is the tenant's own business data and authorises
            nothing, so it is safe to show. The masked account line is deliberately
            partial: enough to recognise, not enough to reconstruct. */}
        {automated && channel?.hashback_account_id && (
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            Channel: {channel.channel_shortcode ?? channel.hashback_account_id}
          </p>
        )}
      </div>
    </Card>
  )
}

export function NetworkSettingsPage() {
  const n = useResource<NetworkSettings | null>(api.fetchNetworkSettings,
    async (v) => api.saveNetworkSettings(v ?? {}))
  const [d, setD] = useState<Partial<NetworkSettings>>({})

  useEffect(() => { if (n.value) setD(n.value) }, [n.value])

  if (n.loading) return <Spinner label="Loading network settings..." />

  const set = <K extends keyof NetworkSettings>(k: K, v: NetworkSettings[K]) =>
    setD((x) => ({ ...x, [k]: v }))

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-black tracking-tight text-slate-900 dark:text-white">
          Network Settings
        </h1>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
          Applied to your routers by the provisioning script.
        </p>
      </div>

      {n.error && <Alert kind="error">{n.error}</Alert>}
      {n.notice && <Alert kind="success">{n.notice}</Alert>}

      <Card>
        <CardHeader title="DNS and time" icon={<Globe className="w-4 h-4" />} />
        <div className="p-5 grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Field label="Primary DNS">
            <input className={inputClass} value={d.primary_dns ?? ''}
              onChange={(e) => set('primary_dns', e.target.value)} placeholder="1.1.1.1" />
          </Field>
          <Field label="Secondary DNS">
            <input className={inputClass} value={d.secondary_dns ?? ''}
              onChange={(e) => set('secondary_dns', e.target.value)} placeholder="8.8.8.8" />
          </Field>
          <Field label="NTP server">
            <input className={inputClass} value={d.ntp_server ?? ''}
              onChange={(e) => set('ntp_server', e.target.value)} placeholder="pool.ntp.org" />
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader title="Sessions" icon={<Globe className="w-4 h-4" />} />
        <div className="p-5 grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Field label="Idle timeout (minutes)">
            <input className={inputClass} type="number" min={1} max={120}
              value={d.idle_timeout_min ?? 5}
              onChange={(e) => set('idle_timeout_min', Number(e.target.value))} />
          </Field>
          <Field label="Keepalive timeout (minutes)">
            <input className={inputClass} type="number" min={1} max={1440}
              value={d.session_timeout_min ?? 30}
              onChange={(e) => set('session_timeout_min', Number(e.target.value))} />
          </Field>
          <Field label="Grace period (days)">
            <input className={inputClass} type="number" min={0} max={30}
              value={d.grace_period_days ?? 0}
              onChange={(e) => set('grace_period_days', Number(e.target.value))} />
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader title="RADIUS" icon={<ShieldCheck className="w-4 h-4" />} />
        <div className="p-5 space-y-4">
          <label className="flex items-center justify-between gap-3 cursor-pointer">
            <span className="text-xs font-bold text-slate-700 dark:text-slate-200">
              Use RADIUS for authentication
            </span>
            <input type="checkbox" checked={Boolean(d.radius_enabled)}
              onChange={(e) => set('radius_enabled', e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-violet-600" />
          </label>
          <Field label="RADIUS server address">
            <input className={inputClass} value={d.radius_server ?? ''}
              onChange={(e) => set('radius_server', e.target.value)} placeholder="10.0.0.1" />
          </Field>
          <p className="text-[11px] text-slate-400">
            The shared RADIUS secret is encrypted and readable only by the Edge
            Function. It is never returned to this page.
          </p>
        </div>
      </Card>

      <div className="flex justify-end">
        <Button size="sm" disabled={n.busy} icon={<Save className="w-3.5 h-3.5" />}
          onClick={() => void n.persist({
            ...(n.value as NetworkSettings), ...d,
          } as NetworkSettings)}>
          {n.busy ? 'Saving...' : 'Save network settings'}
        </Button>
      </div>
    </div>
  )
}
export function SmsSettingsPage() {
  const s = useResource<SmsSettings | null>(api.fetchSmsSettings,
    async (v) => api.saveSmsSettings(v ?? {}))
  const [d, setD] = useState<Partial<SmsSettings>>({})

  useEffect(() => { if (s.value) setD(s.value) }, [s.value])

  if (s.loading) return <Spinner label="Loading SMS settings..." />

  const set = <K extends keyof SmsSettings>(k: K, v: SmsSettings[K]) =>
    setD((x) => ({ ...x, [k]: v }))

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-black tracking-tight text-slate-900 dark:text-white">
          SMS Settings
        </h1>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
          Which messages go out automatically, and through which provider.
        </p>
      </div>

      {s.error && <Alert kind="error">{s.error}</Alert>}
      {s.notice && <Alert kind="success">{s.notice}</Alert>}

      <Card>
        <CardHeader title="Provider" icon={<MessageSquare className="w-4 h-4" />} />
        <div className="p-5 space-y-4">
          <Field label="Provider">
            <select className={inputClass} value={d.provider ?? 'none'}
              onChange={(e) => set('provider', e.target.value as SmsSettings['provider'])}>
              <option value="none">Not configured</option>
              <option value="africas_talking">Africa&apos;s Talking</option>
              <option value="smspro">SmsPro</option>
              <option value="twilio">Twilio</option>
            </select>
          </Field>
          {(d.provider ?? 'none') === 'none' ? (
            <Alert kind="info">
              Without a provider, messages are recorded but not delivered. Add
              credentials from the Super Admin panel, or ask your operator.
            </Alert>
          ) : (
            <Badge value={d.secret_set ? 'credentials saved' : 'credentials missing'} />
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Sender ID">
              <input className={inputClass} value={d.sender_id ?? ''}
                onChange={(e) => set('sender_id', e.target.value)} placeholder="MYISP" />
            </Field>
            <Field label="Account ID">
              <input className={inputClass} value={d.account_id ?? ''}
                onChange={(e) => set('account_id', e.target.value)} />
            </Field>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Automatic messages" icon={<MessageSquare className="w-4 h-4" />} />
        <div className="p-5 space-y-4">
          {([
            ['send_on_voucher_purchase', 'Send the voucher code after a purchase'],
            ['send_on_payment', 'Confirm a payment'],
            ['send_on_expiry_warning', 'Warn before a package expires'],
            ['send_on_account_created', 'Welcome a new customer'],
          ] as const).map(([k, label]) => (
            <label key={k} className="flex items-center justify-between gap-3 cursor-pointer">
              <span className="text-xs font-bold text-slate-700 dark:text-slate-200">{label}</span>
              <input type="checkbox" checked={Boolean(d[k])}
                onChange={(e) => set(k, e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-violet-600" />
            </label>
          ))}
          <Field label="Warn this many days before expiry">
            <input className={inputClass} type="number" min={0} max={30}
              value={d.expiry_warning_days ?? 3}
              onChange={(e) => set('expiry_warning_days', Number(e.target.value))} />
          </Field>
        </div>
      </Card>

      <div className="flex justify-end">
        <Button size="sm" disabled={s.busy} icon={<Save className="w-3.5 h-3.5" />}
          onClick={() => void s.persist({
            ...(s.value as SmsSettings), ...d,
          } as SmsSettings)}>
          {s.busy ? 'Saving...' : 'Save SMS settings'}
        </Button>
      </div>
    </div>
  )
}