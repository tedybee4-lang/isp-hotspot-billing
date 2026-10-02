import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { Wifi, ArrowRight, Building2, LogOut } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'
import { signupIsp } from '../lib/data'
import { config } from '../lib/config'
import { Alert, Button, Field, inputClass } from '../components/ui'

/** Two-step: create the login, then claim the tenant. */
export default function Register() {
  const { user, signUp, signOut, refresh } = useAuth()
  const { darkMode, toggleTheme } = useTheme()
  const navigate = useNavigate()

  const [step, setStep] = useState<1 | 2>(1)
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [ispName, setIspName] = useState('')
  const [slug, setSlug] = useState('')
  const [phone, setPhone] = useState('')
  const [county, setCounty] = useState('Nairobi')
  const [city, setCity] = useState('Nairobi')
  const [address, setAddress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (user?.profile.role === 'super_admin') return <Navigate to="/admin" replace />
  if (user?.isp) return <Navigate to="/app" replace />

  async function submitAccount(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await signUp(email, password, fullName)
      await refresh()
      setStep(2)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the account.')
    } finally {
      setBusy(false)
    }
  }

  async function submitIsp(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await signupIsp({
        name: ispName, slug, phone, county, city, address, brandColor: '#7c3aed',
      })
      await refresh()
      navigate('/app', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not register the ISP.')
    } finally {
      setBusy(false)
    }
  }

const shell = (children: React.ReactNode) => (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center p-6 relative">
      <button
        onClick={toggleTheme}
        className="absolute top-5 right-5 p-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-500 hover:text-slate-900 dark:hover:text-white transition"
        title="Toggle theme"
      >
        <span className="text-sm">{darkMode ? '🌙' : '☀️'}</span>
      </button>

      <div className="w-full max-w-md">
        <div className="flex items-center gap-3 mb-8">
          <div className="h-11 w-11 bg-gradient-to-tr from-violet-600 to-cyan-500 rounded-xl flex items-center justify-center">
            <Wifi className="w-6 h-6 text-white stroke-[2.5]" />
          </div>
          <div>
            <h1 className="text-xl font-black tracking-tight text-slate-900 dark:text-white">
              ISP<span className="text-violet-600 dark:text-cyan-400">Flow</span>
            </h1>
            <span className="text-[10px] text-slate-400 font-mono tracking-widest uppercase">
              Onboard your ISP
            </span>
          </div>
        </div>

        {children}
      </div>
    </div>
  )

  // ── Step 1: the account ────────────────────────────────────────────────────
  if (step === 1) {
    return shell(
      <form onSubmit={submitAccount} className="space-y-5">
        <div>
          <h2 className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">
            Create your login
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Step 1 of 2 — this becomes the ISP owner account.
          </p>
        </div>

        {error && <Alert kind="error">{error}</Alert>}

        <Field label="Full name">
          <input required value={fullName} onChange={(e) => setFullName(e.target.value)}
            className={inputClass} placeholder="Jane Wanjiku" />
        </Field>

        <Field label="Work email">
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
            className={inputClass} placeholder="jane@yourisp.co.ke" />
        </Field>

        <Field label="Password" hint="At least 8 characters.">
          <input type="password" required minLength={8} value={password}
            onChange={(e) => setPassword(e.target.value)} className={inputClass} />
        </Field>

        <Button type="submit" loading={busy} className="w-full" icon={<ArrowRight className="w-4 h-4" />}>
          Continue
        </Button>

        <p className="text-center text-xs text-slate-500 dark:text-slate-400">
          Already registered?{' '}
          <Link to="/login" className="font-bold text-violet-600 dark:text-violet-400 hover:underline">
            Sign in
          </Link>
        </p>
      </form>,
    )
  }

// ── Step 2: the tenant ───────────────────────────────────────────────────────
  return shell(
    <>
      <form onSubmit={submitIsp} className="space-y-5">
        <div>
          <h2 className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">
            Register your ISP
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Step 2 of 2 — we create your tenant, starter plans and a 14-day trial.
          </p>
        </div>

        {error && <Alert kind="error">{error}</Alert>}

        <Field label="ISP name">
          <input required value={ispName} onChange={(e) => setIspName(e.target.value)}
            className={inputClass} placeholder="Achieng Broadband Ltd" />
        </Field>

        <Field label="Portal subdomain" hint={`Your captive portal will live at ${config.appUrl}/portal/<subdomain>`}>
          <div className="flex items-center gap-2">
            <input required pattern="[a-z0-9-]+" minLength={3} value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              className={inputClass} placeholder="achieng-broadband" />
            <span className="text-[11px] text-slate-400 font-mono whitespace-nowrap">.portal</span>
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Phone">
            <input required value={phone} onChange={(e) => setPhone(e.target.value)}
              className={inputClass} placeholder="07XXXXXXXX" />
          </Field>
          <Field label="City">
            <input required value={city} onChange={(e) => setCity(e.target.value)} className={inputClass} />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="County">
            <input required value={county} onChange={(e) => setCounty(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Address">
            <input value={address} onChange={(e) => setAddress(e.target.value)}
              className={inputClass} placeholder="Optional" />
          </Field>
        </div>

        <Button type="submit" loading={busy} className="w-full" icon={<Building2 className="w-4 h-4" />}>
          Create ISP workspace
        </Button>

        <button
          type="button"
          onClick={() => void signOut()}
          className="w-full flex items-center justify-center gap-1.5 text-[11px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition"
        >
          <LogOut className="w-3 h-3" /> Use a different account
        </button>
      </form>

      <p className="mt-6 text-[10px] text-slate-400 text-center leading-relaxed">
        By continuing you agree that a platform super admin can review and manage
        this tenant's status, plan limits and payment configuration.
      </p>
    </>,
  )
}