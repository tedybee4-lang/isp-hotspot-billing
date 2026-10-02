/**
 * Public captive portal for one tenant, served at /portal/:slug.
 * This is what an MikroTik hotspot redirects to. No login required — the
 * voucher itself is the credential.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Wifi, LogIn, LogOut, ShieldCheck, CheckCircle2 } from 'lucide-react'
import { redeemVoucher } from '../lib/data'
import { loadDb } from '../lib/demoStore'
import type { Isp, Plan } from '../lib/types'
import { cn } from '../utils/cn'
import { Alert, Button, Card, Field, Spinner, inputClass } from '../components/ui'

interface PortalState { isp: Isp; plans: Plan[] }

export default function CaptivePortal() {
  const { slug } = useParams<{ slug: string }>()
  const [state, setState] = useState<PortalState | null>(null)
  const [missing, setMissing] = useState(false)
  const [code, setCode] = useState('')
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const isp = loadDb().isps.find((i) => i.slug === slug)
    if (!isp) { setMissing(true); return }
    setState({
      isp,
      plans: loadDb().plans
        .filter((p) => p.isp_id === isp.id && p.kind === 'hotspot' && p.is_active)
        .sort((a, b) => Number(a.price) - Number(b.price)),
    })
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

  if (!state) return <CenteredShell><Spinner label="Loading portal…" /></CenteredShell>

  const { isp, plans } = state
  const brand = isp.brand_color

  if (connected) {
    return (
      <CenteredShell accent={brand}>
        <Card className="p-8 text-center">
          <CheckCircle2 className="w-14 h-14 mx-auto text-emerald-500" />
          <h1 className="text-xl font-black text-slate-900 dark:text-white mt-4">You're online</h1>
          <p className="text-sm text-slate-600 dark:text-slate-300 mt-2">{result?.message}</p>
          <p className="text-[11px] text-slate-400 mt-3 font-mono">{isp.name} · RouterOS hotspot</p>
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
            {isp.name}
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Enter your voucher code to get online
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

        {plans.length > 0 && (
          <Card>
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800">
              <h2 className="text-xs font-black text-slate-800 dark:text-white">Buy a package</h2>
              <p className="text-[10px] text-slate-500 dark:text-slate-400">
                Pay with M-Pesa and your code arrives instantly.
              </p>
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {plans.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-slate-800 dark:text-white">{p.name}</p>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 font-mono">
                      {p.duration_label} · up to {p.speed_down}
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
          Secured by {isp.name} · Powered by ISPFlow
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