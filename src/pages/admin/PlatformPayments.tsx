import { useEffect, useState } from 'react'
import { CreditCard, ShieldCheck, Building2, Info, CheckCircle2 } from 'lucide-react'
import {
  fetchPlatformPaymentStatus, updatePlatformPaymentConfig,
  fetchIspStats, PAYMENT_MODES,
} from '../../lib/data'
import type { PlatformPaymentStatus } from '../../lib/data'
import {
  Alert, Badge, Button, Card, CardHeader, Field, Spinner,
  StatTile, inputClass,
} from '../../components/ui'

/**
 * Platform-wide payment settings.
 *
 * Shared Daraja credentials here let every tenant switch to "Platform Daraja"
 * and collect via STK Push without ever seeing an API key.
 */
export default function PlatformPayments() {
  const [cfg, setCfg] = useState<PlatformPaymentStatus | null>(null)
  const [tenantCount, setTenantCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const [env, setEnv] = useState<'sandbox' | 'production'>('sandbox')
  const [passkey, setPasskey] = useState('')
  const [consumerKey, setConsumerKey] = useState('')
  const [consumerSecret, setConsumerSecret] = useState('')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [status, isps] = await Promise.all([
          fetchPlatformPaymentStatus(),
          fetchIspStats(),
        ])
        if (cancelled) return
        setCfg(status)
        setEnv(status.mpesa_env)
        setTenantCount(isps.length)
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      }
    })()
    return () => { cancelled = true }
  }, [])

  async function save() {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      await updatePlatformPaymentConfig({
        mpesa_env: env,
        mpesa_passkey: passkey,
        mpesa_consumer_key: consumerKey,
        mpesa_consumer_secret: consumerSecret,
      })
      setPasskey(''); setConsumerKey(''); setConsumerSecret('')
      setCfg(await fetchPlatformPaymentStatus())
      setSaved(true)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (error && !cfg) {
    return <Card className="p-6"><p className="text-sm font-bold text-rose-600">{error}</p></Card>
  }
  if (!cfg) return <Spinner label="Loading payment settings…" />

return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">
          Platform Payments
        </h1>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
          Shared Safaricom Daraja credentials. One setup, every tenant.
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatTile
          label="Shared Daraja" value={cfg.ready ? 'Active' : 'Not set up'}
          icon={<ShieldCheck className="w-5 h-5" />}
          tone={cfg.ready ? 'emerald' : 'amber'}
          hint={`${cfg.mpesa_env} environment`}
        />
        <StatTile
          label="ISPs on platform" value={tenantCount}
          icon={<Building2 className="w-5 h-5" />} tone="violet"
          hint="Can all use the shared keys"
        />
      </div>

      <Card>
        <CardHeader
          title="Shared Safaricom Daraja account"
          subtitle="Optional — only needed for ISPs using the 'Platform Daraja' mode."
          icon={<CreditCard className="w-4 h-4" />}
          action={<Badge value={cfg.ready ? 'ready' : 'not_configured'} />}
        />

        <div className="p-5 space-y-4">
          {error && <Alert kind="error">{error}</Alert>}
          {saved && <Alert kind="success">Shared credentials saved.</Alert>}

          <Alert kind="success">
            <span className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-px" />
              <span>
                Leave this empty if every ISP will use <strong>Manual Till</strong> or bring
                their own Daraja keys. Manual Till needs no credentials at all.
              </span>
            </span>
          </Alert>

          <Field group label="Environment">
            <div className="grid grid-cols-2 gap-2">
              {(['sandbox', 'production'] as const).map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => setEnv(e)}
                  className={`rounded-xl border px-3 py-2.5 text-[11px] font-bold capitalize transition ${
                    env === e
                      ? 'border-violet-500 bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300'
                      : 'border-slate-300 dark:border-slate-700 text-slate-500 dark:text-slate-400'
                  }`}
                >
                  {e}
                </button>
              ))}
            </div>
          </Field>

          {env === 'production' && (
            <Alert kind="error">
              Production pushes charge real money. Test everything in sandbox first.
            </Alert>
          )}

          <SecretRow label="Lipa na M-Pesa Online passkey"
            value={passkey} onChange={setPasskey} saved={cfg.has_passkey} />
          <SecretRow label="Daraja consumer key"
            value={consumerKey} onChange={setConsumerKey} saved={cfg.has_consumer_key} />
          <SecretRow label="Daraja consumer secret"
            value={consumerSecret} onChange={setConsumerSecret} saved={cfg.has_consumer_secret} />

          <Button loading={saving} onClick={save} icon={<CreditCard className="w-4 h-4" />}>
            Save shared credentials
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Payment modes an ISP can use"
          subtitle="Every tenant picks one of these on its detail screen"
          icon={<Info className="w-4 h-4" />}
        />
        <div className="p-5 grid grid-cols-1 md:grid-cols-3 gap-3">
          {PAYMENT_MODES.map((m) => (
            <div key={m.value} className="rounded-xl border border-slate-200 dark:border-slate-800 p-4">
              <div className="flex items-center justify-between gap-2 mb-2">
                <p className="text-xs font-bold text-slate-800 dark:text-white">{m.label}</p>
                <Badge value={m.needsKeys ? 'own_keys' : 'no_keys'} />
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">{m.blurb}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}

function SecretRow({
  label, value, onChange, saved,
}: { label: string; value: string; onChange: (v: string) => void; saved: boolean }) {
  return (
    <Field label={label} hint={saved ? 'Already saved — leave blank to keep it.' : undefined}>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${inputClass} font-mono text-[11px]`}
        placeholder={saved ? '•••••••• (saved)' : 'from the Daraja portal'}
        autoComplete="off"
      />
    </Field>
  )
}