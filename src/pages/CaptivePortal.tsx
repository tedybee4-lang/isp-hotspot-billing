/**
 * Public captive portal for one tenant, served at /portal/:slug.
 * This is what an MikroTik hotspot redirects to. No login required ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â the
 * voucher itself is the credential.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Wifi, LogIn, LogOut, ShieldCheck, CheckCircle2 } from 'lucide-react'
import { redeemVoucher } from '../lib/data'
import { fetchPublicPortalSettings, fetchPublicPortalPackages, type PortalSettings } from '../lib/data'
import { loadDb } from '../lib/demoStore'
import { config } from '../lib/config'
import type { Isp, Plan } from '../lib/types'
import { cn } from '../utils/cn'
import { Alert, Button, Card, Field, Spinner, inputClass } from '../components/ui'

interface PortalState { isp: Isp; plans: Plan[]; settings: PortalSettings | null }

export default function CaptivePortal() {
  const { slug } = useParams<{ slug: string }>()
  const [state, setState] = useState<PortalState | null>(null)
  const [missing, setMissing] = useState(false)
  const [code, setCode] = useState('')
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState(false)

  // Load the ISP's own portal settings alongside its plans. The slug identifies
  // the tenant; nothing about another ISP is ever fetched here.
  useEffect(() => {
    let live = true
    void (async () => {
      const isp = loadDb().isps.find((i) => i.slug === slug)
      if (!isp) { setMissing(true); return }

      let settings: PortalSettings | null = null
      let plans: Plan[]
      try {
        settings = await fetchPublicPortalSettings(slug!)
      } catch {
        // No backend, or no settings yet: fall back to the ISP defaults.
        settings = null
      }

      // Against a live project the packages come from the public RPC, because
      // an anonymous visitor cannot read `plans` under RLS. The demo store is
      // read directly since it has no tenancy to enforce.
      if (config.mode === 'live') {
        try {
          const rows = await fetchPublicPortalPackages(slug!)
          plans = rows
            .filter((r) => r.kind === 'hotspot')
            .map((r) => ({
              // The RPC returns presentation columns, so the local Plan shape is
              // filled in rather than spread: a missing field must not become
              // undefined in a place the page renders as a price.
              id: r.id,
              isp_id: isp.id,
              name: r.name,
              kind: r.kind as Plan['kind'],
              price: r.price,
              currency: 'KES',
              duration_hours: r.duration_hours ?? 0,
              duration_label: r.duration_label ?? '',
              speed_down: r.speed_down ?? null,
              speed_up: r.speed_up ?? null,
              data_limit: r.data_limit ?? null,
              device_limit: 1,
              fup: r.fup,
              price_type: 'voucher',
              status: 'active',
              is_active: true,
              show_on_portal: true,
              is_popular: r.is_popular,
              description: r.description,
              validity_days: 0,
              shared_users: 0,
              created_at: '',
            })) as unknown as Plan[]
        } catch {
          plans = []
        }
      } else {
        plans = loadDb().plans
          .filter((p) => p.isp_id === isp.id && p.kind === 'hotspot' && p.is_active)
          .sort((a, b) => Number(a.price) - Number(b.price))
      }

      if (!live) return
      setState({ isp, plans, settings })
    })()
    return () => { live = false }
  }, [slug])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!code.trim()) return
    setBusy(true)
    setResult(null)
    try {
      const res = await redeemVoucher(code.trim())
      setResult({ ok: res.success, message: res.message })
      setConnected(res.success)
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : 'Verification failed.' })
    } finally {
      setBusy(false)
    }
  }

  if (missing) {
    return (
      <CenteredShell>
        <Card className="p-8 text-center">
          <h1 className="text-lg font-black text-slate-900 dark:text-white">Portal not found</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">
            No ISP is registered at <span className="font-mono">/portal/{slug}</span>.
          </p>
          <Link to="/login" className="inline-block mt-4">
            <Button size="sm">Go to sign in</Button>
          </Link>
        </Card>
      </CenteredShell>
    )
  }

  if (!state) return <CenteredShell><Spinner label="Loading portalÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦" /></CenteredShell>

  const { isp, plans, settings } = state
  // The portal renders whatever the ISP configured in Settings -> Captive
  // Portal. In demo mode there is no backend, so it falls back to the ISP's
  // brand colour rather than showing empty fields.
  const brand = settings?.primary_color || isp.brand_color
  const title = settings?.portal_name || isp.name
  const subtitle = settings?.welcome_message || 'Enter your voucher code to get online'
  const footer = settings?.footer_text || `${isp.name}`
  const showPackages = settings ? settings.show_packages : true
  const visible = showPackages && settings?.package_ids?.length
    ? plans.filter((p) => settings.package_ids.includes(p.id))
    : plans

  if (connected) {
    return (
      <CenteredShell accent={brand}>
        <Card className="p-8 text-center">
          <CheckCircle2 className="w-14 h-14 mx-auto text-emerald-500" />
          <h1 className="text-xl font-black text-slate-900 dark:text-white mt-4">You're online</h1>
          <p className="text-sm text-slate-600 dark:text-slate-300 mt-2">{result?.message}</p>
          <p className="text-[11px] text-slate-400 mt-3 font-mono">{isp.name} ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· RouterOS hotspot</p>
          <Button
            variant="secondary" className="mt-6"
            onClick={() => { setConnected(false); setCode(''); setResult(null) }}
            icon={<LogOut className="w-4 h-4" />}
          >
            Disconnect
          </Button>
        </Card>
      </CenteredShell>
    )
  }

return (
    <CenteredShell accent={brand}>
      <div className="w-full max-w-md space-y-5">
        <div className="text-center">
          <span
            className="inline-grid place-items-center w-14 h-14 rounded-2xl text-white mb-4 shadow-lg"
            style={{ backgroundColor: brand }}
          >
            <Wifi className="w-7 h-7 stroke-[2.5]" />
          </span>
          <h1 className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">
            {title}
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {subtitle}
          </p>
        </div>

        <Card className="p-5">
          <form onSubmit={submit} className="space-y-4">
            {result && !result.ok && <Alert kind="error">{result.message}</Alert>}

            <Field label="Voucher code">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="XXXX-0000"
                className={cn(inputClass, 'text-center font-mono text-lg tracking-widest uppercase')}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>

            <Button type="submit" loading={busy} className="w-full" icon={<LogIn className="w-4 h-4" />}>
              Connect
            </Button>
          </form>
        </Card>

                {visible.length > 0 && (
          <Card>
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800">
              <h2 className="text-xs font-black text-slate-800 dark:text-white">Buy a package</h2>
              <p className="text-[10px] text-slate-500 dark:text-slate-400">
                Pay with M-Pesa and your code arrives instantly.
              </p>
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {visible.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-slate-800 dark:text-white">{p.name}</p>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 font-mono">
                      {p.duration_label} ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· up to {p.speed_down}
                    </p>
                  </div>
                  <span className="text-sm font-black text-slate-900 dark:text-white font-mono shrink-0">
                    KES {Number(p.price).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        )}

        <p className="text-center text-[10px] text-slate-400 flex items-center justify-center gap-1.5">
          <ShieldCheck className="w-3.5 h-3.5" />
          Secured by {footer}
        </p>
      </div>
    </CenteredShell>
  )
}

function CenteredShell({ children, accent }: { children: ReactNode; accent?: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-5 bg-slate-50 dark:bg-slate-950 relative overflow-hidden">
      {accent && (
        <div
          className="absolute inset-0 opacity-[0.07] dark:opacity-[0.12]"
          style={{ background: `radial-gradient(circle at 50% 0%, ${accent}, transparent 60%)` }}
        />
      )}
      <div className="relative w-full flex justify-center">{children}</div>
    </div>
  )
}
