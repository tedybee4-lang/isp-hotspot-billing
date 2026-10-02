/**
 * ISP payment settings — self service.
 *
 * An ISP configures its own M-Pesa collection channel here without involving the
 * platform owner. What the screen deliberately does NOT contain: the platform
 * API key, the webhook secret, any Daraja credential, or any encryption key. It
 * shows the ISP's own shortcode and its own HashBack Account ID, because those
 * are its business data and they authorise nothing.
 *
 * The tenant is never named by the page. `fetchMyPaymentChannel()` takes no ISP
 * id — the server resolves the caller's membership — so there is no field here
 * that could be pointed at another ISP even if a caller edited the request.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  CreditCard, Save, Link2, CircleCheck, CircleAlert, Info, ShieldCheck, Store,
} from 'lucide-react'
import {
  fetchMyPaymentChannel,
  saveMyPaymentChannel,
  PaymentError,
  type MyPaymentChannel,
} from '../../../lib/payments'
import { config } from '../../../lib/config'
import {
  Alert, Badge, Button, Card, CardHeader, Field, Spinner, inputClass,
} from '../../../components/ui'

/** Only the two channel types HashBack documents are offered. */
const CHANNEL_OPTIONS = [
  {
    value: 'CustomerBuyGoodsOnline' as const,
    label: 'Till / Buy Goods',
    hint: 'Customers pay to a Till number using M-Pesa “Send Money”.',
  },
  {
    value: 'CustomerPayBillOnline' as const,
    label: 'PayBill',
    hint: 'Customers pay to a PayBill and quote the account reference.',
  },
]

const STATUS_TONE: Record<string, string> = {
  not_configured: 'slate',
  pending: 'amber',
  connected: 'emerald',
  failed: 'rose',
  disabled: 'slate',
}

const STATUS_LABEL: Record<string, string> = {
  not_configured: 'NOT CONFIGURED',
  pending: 'PENDING — CONNECTING',
  connected: 'CONNECTED',
  failed: 'FAILED',
  disabled: 'DISABLED',
}

function ago(iso: string | null): string {
  if (!iso) return 'never'
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

export function HashBackPaymentSettings() {
  const [channel, setChannel] = useState<MyPaymentChannel | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [merchantName, setMerchantName] = useState('')
  const [channelType, setChannelType] = useState<
    'CustomerBuyGoodsOnline' | 'CustomerPayBillOnline'
  >('CustomerBuyGoodsOnline')
  const [shortcode, setShortcode] = useState('')

  const load = useCallback(async () => {
    try {
      const c = await fetchMyPaymentChannel()
      setChannel(c)
      if (c) {
        setMerchantName(c.merchant_name ?? '')
        if (c.channel_type) setChannelType(c.channel_type)
        setShortcode(c.channel_shortcode ?? c.till_number ?? c.paybill_number ?? '')
      }
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function save() {
    setSaving(true); setError(null); setNotice(null)
    try {
      const next = await saveMyPaymentChannel({
        merchantName,
        channelType,
        shortcode,
        paybillNumber: channelType === 'CustomerPayBillOnline' ? shortcode : '',
        tillNumber: channelType === 'CustomerBuyGoodsOnline' ? shortcode : '',
      })
      setChannel(next)
      setNotice('Saved. Your channel is marked Connected once HashBack confirms it.')
    } catch (err) {
      setError(err instanceof PaymentError ? err.message : 'Could not save.')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <Spinner label="Loading your payment settings..." />

  if (config.mode !== 'live') {
    return (
      <Card>
        <CardHeader title="M-Pesa collection" icon={<CreditCard className="h-4 w-4" />} />
        <div className="p-5">
          <Alert kind="info">
            Demo mode: nothing is sent to a payment provider. Configure Supabase to
            connect a real Till or PayBill.
          </Alert>
        </div>
      </Card>
    )
  }

  const status = channel?.connection_status ?? 'not_configured'
  const isPaybill = channelType === 'CustomerPayBillOnline'
  const selected = CHANNEL_OPTIONS.find((o) => o.value === channelType)

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-black tracking-tight text-slate-900 dark:text-white">
          Payment Settings
        </h1>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          Your own M-Pesa Till or PayBill. Customers pay you directly; you never
          need to handle API keys or passwords.
        </p>
      </div>

      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}

      <Card>
        <CardHeader
          title="M-Pesa collection"
          icon={<CreditCard className="h-4 w-4" />}
          action={
            <Badge
              value={STATUS_LABEL[status] ?? status.toUpperCase()}
              className={STATUS_TONE[status] ?? 'slate'}
            />
          }
        />
        <div className="space-y-4 p-5">
          <Field label="Merchant / company name" hint="Shown to customers on the payment prompt.">
            <input
              className={inputClass}
              value={merchantName}
              onChange={(e) => setMerchantName(e.target.value)}
              placeholder="Your ISP or business name"
              maxLength={80}
            />
          </Field>

          <div>
            <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Channel type
            </span>
            <div className="grid gap-2 sm:grid-cols-2">
              {CHANNEL_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setChannelType(opt.value)}
                  className={`rounded-lg border p-3 text-left transition ${
                    channelType === opt.value
                      ? 'border-emerald-500/60 bg-emerald-500/10'
                      : 'border-slate-700 hover:border-slate-500'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Store className="h-3.5 w-3.5 text-slate-400" />
                    <span className="text-sm font-medium text-slate-200">{opt.label}</span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{opt.hint}</p>
                </button>
              ))}
            </div>
          </div>

          <Field
            label={isPaybill ? 'PayBill number' : 'Till number'}
            hint={selected?.hint}
          >
            <input
              className={`${inputClass} font-mono`}
              value={shortcode}
              onChange={(e) => setShortcode(e.target.value.replace(/\D/g, '').slice(0, 8))}
              inputMode="numeric"
              placeholder={isPaybill ? '247247' : '522533'}
            />
          </Field>

          <Button
            loading={saving}
            icon={<Save className="h-3.5 w-3.5" />}
            onClick={() => void save()}
          >
            {saving ? 'Saving...' : 'Save & connect payment channel'}
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader title="Channel status" icon={<Link2 className="h-4 w-4" />} />
        <div className="space-y-3 p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-slate-800 p-3">
              <div className="text-xs text-slate-500">HashPay account</div>
              <div className="mt-0.5 font-mono text-sm text-slate-200">
                {channel?.hashback_account_id ?? '—'}
              </div>
              {!channel?.hashback_account_id && (
                <p className="mt-1 text-xs text-slate-500">
                  Not issued yet. Save your channel details first.
                </p>
              )}
            </div>
            <div className="rounded-lg border border-slate-800 p-3">
              <div className="text-xs text-slate-500">Last verified</div>
              <div className="mt-0.5 font-mono text-sm text-slate-200">
                {ago(channel?.last_verified_at ?? null)}
              </div>
              {channel?.provider_status && (
                <div className="mt-1 text-xs text-slate-500">
                  Provider says: {channel.provider_status}
                </div>
              )}
            </div>
          </div>

          {status === 'connected' && (
            <Alert kind="success">
              <div className="flex items-start gap-2">
                <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Connected. Customers paying with M-Pesa are charged to your{' '}
                  {isPaybill ? 'PayBill' : 'Till'} and their account is activated
                  automatically once HashBack confirms the payment.
                </span>
              </div>
            </Alert>
          )}

          {status === 'pending' && (
            <Alert kind="info">
              <div className="flex items-start gap-2">
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Saved and waiting for HashBack to confirm the channel. Customers
                  cannot pay through this channel until it reads Connected.
                </span>
              </div>
            </Alert>
          )}

          {(status === 'failed' || status === 'not_configured') && (
            <Alert kind="warning">
              <div className="flex items-start gap-2">
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {channel?.last_error
                    ?? 'This channel is not collecting payments yet. Check the Till '
                       + 'or PayBill number and save again.'}
                </span>
              </div>
            </Alert>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="Security" icon={<ShieldCheck className="h-4 w-4" />} />
        <div className="p-5">
          <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
            The platform's HashBack API key, the webhook signing secret and the
            encryption key are all held server-side and encrypted. They are never
            sent to this page and cannot be read from it — which is why you see
            only your own Till, PayBill and account ID here. You do not need to
            know or manage any of them to collect payments.
          </p>
        </div>
      </Card>
    </div>
  )
}