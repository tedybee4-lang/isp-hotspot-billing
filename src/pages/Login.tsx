import { useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Wifi, Sun, Moon, ShieldCheck, Server, LogIn } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'
import { config } from '../lib/config'
import { Alert, Button, Field, inputClass } from '../components/ui'

export default function Login() {
  const { user, signIn } = useAuth()
  const { darkMode, toggleTheme } = useTheme()
  const navigate = useNavigate()
  const location = useLocation() as { state?: { from?: string } }

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Route by role once we know who they are.
  if (user) {
    const home = user.profile.role === 'super_admin' ? '/admin' : user.isp ? '/app' : '/register'
    return <Navigate to={location.state?.from ?? home} replace />
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const next = await signIn(email, password)
      navigate(
        next.profile.role === 'super_admin' ? '/admin' : next.isp ? '/app' : '/register',
        { replace: true },
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in.')
    } finally {
      setBusy(false)
    }
  }

  function useDemo(which: 'super' | 'owner') {
    setEmail(which === 'super' ? config.demo.superAdminEmail : config.demo.ownerEmail)
    setPassword(which === 'super' ? config.demo.superAdminPassword : config.demo.ownerPassword)
    setError(null)
  }

return (
    <div className="min-h-screen flex bg-slate-50 dark:bg-slate-950">
      {/* Brand panel */}
      <div className="hidden lg:flex flex-1 flex-col justify-between bg-slate-900 p-12 text-white relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-violet-600/20 via-transparent to-cyan-500/10" />
        <div className="relative">
          <div className="flex items-center gap-3">
            <div className="h-11 w-11 bg-gradient-to-tr from-violet-600 to-cyan-500 rounded-xl flex items-center justify-center">
              <Wifi className="w-6 h-6 stroke-[2.5]" />
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tight">
                ISP<span className="text-cyan-400">Flow</span>
              </h1>
              <span className="text-[10px] text-slate-400 font-mono tracking-widest uppercase">
                Multi-tenant ISP platform
              </span>
            </div>
          </div>
        </div>

        <div className="relative max-w-md space-y-6">
          <h2 className="text-3xl font-black tracking-tight leading-tight">
            Run every ISP from one control panel.
          </h2>
          <p className="text-sm text-slate-400 leading-relaxed">
            Provision tenants, activate or suspend them, set limits, and watch
            revenue across the whole platform — while each ISP manages its own
            MikroTik network, vouchers and M-Pesa billing in isolation.
          </p>
          <ul className="space-y-3 text-xs text-slate-300">
            {[
              ['Super admin dashboard', 'Full tenant lifecycle control'],
              ['Row-level security', 'Postgres-enforced tenant isolation'],
              ['M-Pesa STK Push', 'Server-side HashBack integration'],
            ].map(([t, d]) => (
              <li key={t} className="flex gap-3">
                <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-px" />
                <span>
                  <strong className="text-white">{t}</strong>
                  <span className="block text-slate-500">{d}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-[10px] text-slate-600 font-mono">
          AS-99411-FAIBANET · RouterOS v7 compatible
        </p>
      </div>

      {/* Form panel */}
      <div className="flex-1 flex items-center justify-center p-6 relative">
        <button
          onClick={toggleTheme}
          className="absolute top-5 right-5 p-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-500 hover:text-slate-900 dark:hover:text-white transition"
          title="Toggle theme"
        >
          {darkMode ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
        </button>

        <div className="w-full max-w-sm">
          <div className="lg:hidden flex items-center gap-3 mb-8">
            <div className="h-10 w-10 bg-gradient-to-tr from-violet-600 to-cyan-500 rounded-xl flex items-center justify-center">
              <Wifi className="w-5 h-5 text-white stroke-[2.5]" />
            </div>
            <h1 className="text-xl font-black tracking-tight text-slate-900 dark:text-white">
              ISP<span className="text-violet-600 dark:text-cyan-400">Flow</span>
            </h1>
          </div>

          <h2 className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">Sign in</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {config.mode === 'demo'
              ? 'Demo mode — data lives in your browser, no server needed.'
              : 'Connected to the live platform database.'}
          </p>

          {config.mode === 'demo' && (
            <div className="mt-4 rounded-xl border border-violet-200 bg-violet-50 dark:border-violet-500/30 dark:bg-violet-500/10 p-3 space-y-2">
              <p className="text-[10px] font-bold text-violet-700 dark:text-violet-300 uppercase tracking-wider font-mono">
                Demo accounts
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Button size="sm" variant="secondary" onClick={() => useDemo('super')} icon={<ShieldCheck className="w-3.5 h-3.5" />}>
                  Super Admin
                </Button>
                <Button size="sm" variant="secondary" onClick={() => useDemo('owner')} icon={<Server className="w-3.5 h-3.5" />}>
                  ISP Owner
                </Button>
              </div>
            </div>
          )}

          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            {error && <Alert kind="error">{error}</Alert>}

            <Field label="Email">
              <input
                type="email" required autoComplete="email" value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClass} placeholder="you@yourisp.co.ke"
              />
            </Field>

            <Field label="Password">
              <input
                type="password" required autoComplete="current-password" value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputClass} placeholder="••••••••"
              />
            </Field>

            <Button type="submit" loading={busy} className="w-full" icon={<LogIn className="w-4 h-4" />}>
              Sign in
            </Button>
          </form>

          <p className="mt-6 text-center text-xs text-slate-500 dark:text-slate-400">
            Running an ISP?{' '}
            <Link to="/register" className="font-bold text-violet-600 dark:text-violet-400 hover:underline">
              Create your account
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}