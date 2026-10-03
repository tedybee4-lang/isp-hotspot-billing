/** Public marketing page for the platform itself. */
import { Link } from 'react-router-dom'
import {
  Wifi, ShieldCheck, Building2, Users, CreditCard, Radio, ArrowRight,
  Server, Database, Lock,
} from 'lucide-react'
import { config } from '../lib/config'
import { Button } from '../components/ui'

const FEATURES = [
  [Building2, 'Tenant management', 'Provision, tier, suspend or remove any ISP from one panel.'],
  [Database, 'Row-level security', 'Postgres-enforced isolation between tenants.'],
  [CreditCard, 'M-Pesa billing', 'STK Push through HashBack, settled by webhook.'],
  [Radio, 'MikroTik operations', 'Voucher engine, sessions and RouterOS scripts.'],
  [Users, 'Per-ISP teams', 'Owners, admins and agents with scoped permissions.'],
  [Lock, 'Full audit trail', 'Every privileged action recorded with actor and tenant.'],
] as const

const ROLES: Array<[string, string, string[]]> = [
  ['Super admin', 'Runs the platform', [
    'Create, tier, suspend and delete ISP tenants',
    'Set per-tenant limits on customers, plans and nodes',
    'Watch platform-wide revenue and churn risk',
    'Add staff users into any tenant',
    'Read the full audit trail',
  ]],
  ['ISP owner / admin', 'Runs their network', [
    'Branded captive portal at /portal/<their-slug>',
    'Voucher generation, sessions and node control',
    'Customer records, invoices and M-Pesa collection',
    'Analytics, RouterOS generator, legal pages',
    'Scoped to their own tenant by RLS',
  ]],
]

export default function PlatformLanding() {
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-200">
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 backdrop-blur sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="h-9 w-9 bg-gradient-to-tr from-violet-600 to-cyan-500 rounded-xl grid place-items-center">
              <Wifi className="w-5 h-5 text-white stroke-[2.5]" />
            </span>
            <span className="text-lg font-black tracking-tight text-slate-900 dark:text-white">
              ISP<span className="text-violet-600 dark:text-cyan-400">Flow</span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/login"><Button size="sm" variant="ghost">Sign in</Button></Link>
            <Link to="/register"><Button size="sm">Register your ISP</Button></Link>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6">
        <section className="py-20 text-center">
          <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-violet-100 dark:bg-violet-500/15 text-violet-700 dark:text-violet-300 text-[11px] font-bold font-mono uppercase tracking-wider mb-6">
            <ShieldCheck className="w-3.5 h-3.5" />
            Multi-tenant SaaS for ISPs
          </span>
          <h1 className="text-4xl md:text-6xl font-black tracking-tight leading-[1.05] text-slate-900 dark:text-white max-w-4xl mx-auto">
            Every ISP on one platform.
            <span className="block bg-gradient-to-r from-violet-600 to-cyan-500 bg-clip-text text-transparent">
              One super admin.
            </span>
          </h1>
          <p className="mt-6 text-base text-slate-600 dark:text-slate-400 max-w-2xl mx-auto leading-relaxed">
            Run hotspot billing, M-Pesa collection and MikroTik management for many ISPs —
            with strict tenant isolation enforced by the database, not by convention.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link to="/register">
              <Button icon={<ArrowRight className="w-4 h-4" />}>Start your 14-day trial</Button>
            </Link>
            <Link to="/login">
              <Button variant="secondary" icon={<Server className="w-4 h-4" />}>Platform sign in</Button>
            </Link>
          </div>
          <p className="mt-4 text-[11px] text-slate-400 font-mono">
            {config.mode === 'demo'
              ? 'Running in demo mode — no backend required'
              : `Live backend at ${config.supabaseUrl.replace('https://', '')}`}
          </p>
        </section>

<section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pb-20">
          {FEATURES.map(([Icon, title, body]) => (
            <div key={title} className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
              <span className="inline-grid place-items-center w-10 h-10 rounded-xl bg-violet-50 dark:bg-violet-500/10 text-violet-600 dark:text-violet-400 mb-4">
                <Icon className="w-5 h-5" />
              </span>
              <h3 className="text-sm font-black text-slate-900 dark:text-white">{title}</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5 leading-relaxed">{body}</p>
            </div>
          ))}
        </section>

        <section className="grid grid-cols-1 md:grid-cols-2 gap-4 pb-20">
          {ROLES.map(([title, sub, points]) => (
            <div key={title} className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
              <h3 className="text-base font-black text-slate-900 dark:text-white">{title}</h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono uppercase tracking-wider mt-0.5">
                {sub}
              </p>
              <ul className="mt-4 space-y-2.5">
                {points.map((p) => (
                  <li key={p} className="flex gap-2.5 text-xs text-slate-600 dark:text-slate-300">
                    <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0 mt-px" />
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      </main>

      <footer className="border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="max-w-6xl mx-auto px-6 py-6 flex flex-col sm:flex-row justify-between items-center gap-3 text-center sm:text-left">
          <p className="text-[11px] text-slate-500">
            ISPFlow — multi-tenant MikroTik hotspot billing platform.
          </p>
          <div className="flex gap-4 text-[11px] text-slate-500">
            <Link to="/login" className="hover:text-violet-600">Sign in</Link>
            <Link to="/register" className="hover:text-violet-600">Register</Link>
            <span className="text-violet-500 font-bold">© {new Date().getFullYear()}</span>
          </div>
        </div>
      </footer>
    </div>
  )
}