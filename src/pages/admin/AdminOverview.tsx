import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Building2, Users, TrendingUp, Wallet, AlertTriangle, Radio,
  ArrowUpRight, Globe, Activity,
} from 'lucide-react'
import { fetchIspStats } from '../../lib/data'
import type { IspStats } from '../../lib/types'
import {
  Badge, Card, CardHeader, EmptyState, Spinner, StatTile, Table, Th, Td, Button,
} from '../../components/ui'

const money = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n.toLocaleString('en', { maximumFractionDigits: 0 })

export default function AdminOverview() {
  const [isps, setIsps] = useState<IspStats[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchIspStats().then(setIsps).catch((e: Error) => setError(e.message))
  }, [])

  const totals = useMemo(() => {
    const list = isps ?? []
    return {
      tenants: list.length,
      active: list.filter((i) => i.status === 'active').length,
      trials: list.filter((i) => i.status === 'trial').length,
      suspended: list.filter((i) => i.status === 'suspended').length,
      churned: list.filter((i) => i.status === 'churned').length,
      clients: list.reduce((s, i) => s + i.active_clients, 0),
      revenue: list.reduce((s, i) => s + Number(i.revenue_30d ?? 0), 0),
      outstanding: list.reduce((s, i) => s + Number(i.outstanding ?? 0), 0),
      nodes: list.reduce((s, i) => s + i.nodes_online, 0),
      churnRisk: list.filter(
        (i) => Number(i.outstanding) > 0 && i.last_payment_at
          && (Date.now() - new Date(i.last_payment_at).getTime()) > 30 * 864e5,
      ),
    }
  }, [isps])

  const ranked = useMemo(
    () => [...(isps ?? [])].sort((a, b) => Number(b.revenue_30d) - Number(a.revenue_30d)),
    [isps],
  )
  const maxRevenue = Math.max(1, ...ranked.map((i) => Number(i.revenue_30d)))

  if (error) {
    return (
      <Card className="p-6">
        <p className="text-sm font-bold text-rose-600">{error}</p>
      </Card>
    )
  }
  if (!isps) return <Spinner label="Loading platform metrics…" />

return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">
            Platform Overview
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Every ISP on the platform, rolled into one view.
          </p>
        </div>
        <Link to="/admin/isps">
          <Button size="sm" icon={<Building2 className="w-3.5 h-3.5" />}>Manage ISPs</Button>
        </Link>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatTile
          label="ISPs on platform" value={totals.tenants} icon={<Building2 className="w-5 h-5" />}
          tone="violet" hint={`${totals.active} active · ${totals.trials} trial`}
        />
        <StatTile
          label="Active subscribers" value={money(totals.clients)} icon={<Users className="w-5 h-5" />}
          tone="sky" hint="Across all tenants"
        />
        <StatTile
          label="Revenue (30d)" value={`KES ${money(totals.revenue)}`} icon={<TrendingUp className="w-5 h-5" />}
          tone="emerald" hint="Successful M-Pesa payments"
        />
        <StatTile
          label="Outstanding" value={`KES ${money(totals.outstanding)}`} icon={<Wallet className="w-5 h-5" />}
          tone="amber" hint="Unpaid + overdue invoices"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card>
          <CardHeader title="Tenant health" subtitle="Lifecycle distribution" icon={<Activity className="w-4 h-4" />} />
          <div className="p-5 space-y-3">
            {([
              ['Active', totals.active, 'bg-emerald-500'],
              ['Trial', totals.trials, 'bg-sky-500'],
              ['Suspended', totals.suspended, 'bg-amber-500'],
              ['Churned', totals.churned, 'bg-slate-400'],
            ] as const).map(([label, count, color]) => {
              const pct = totals.tenants ? (count / totals.tenants) * 100 : 0
              return (
                <div key={label}>
                  <div className="flex justify-between text-[11px] mb-1">
                    <span className="font-bold text-slate-600 dark:text-slate-300">{label}</span>
                    <span className="font-mono text-slate-400">{count}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                    <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )
            })}
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader
            title="Revenue by ISP (30 days)"
            subtitle="Ranked by successful payments"
            icon={<TrendingUp className="w-4 h-4" />}
          />
          {ranked.length === 0 ? (
            <EmptyState title="No tenants yet" hint="Create your first ISP to get started." />
          ) : (
            <div className="p-5 space-y-3">
              {ranked.map((i) => (
                <Link key={i.id} to={`/admin/isps/${i.id}`} className="block group">
                  <div className="flex items-center justify-between text-[11px] mb-1 gap-3">
                    <span className="font-bold text-slate-700 dark:text-slate-200 group-hover:text-violet-600 transition truncate">
                      {i.name}
                    </span>
                    <span className="font-mono text-slate-500 dark:text-slate-400 shrink-0">
                      KES {money(Number(i.revenue_30d))}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all group-hover:opacity-80"
                      style={{
                        width: `${(Number(i.revenue_30d) / maxRevenue) * 100}%`,
                        backgroundColor: i.brand_color,
                      }}
                    />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </Card>
      </div>

      {totals.churnRisk.length > 0 && (
        <Card className="border-amber-300 dark:border-amber-500/30">
          <CardHeader
            title="Needs attention"
            subtitle="Unpaid invoices and no successful payment in 30+ days"
            icon={<AlertTriangle className="w-4 h-4 text-amber-500" />}
          />
          <Table>
            <thead>
              <tr><Th>ISP</Th><Th>Outstanding</Th><Th>Last payment</Th><Th>Status</Th><Th /></tr>
            </thead>
            <tbody>
              {totals.churnRisk.map((i) => (
                <tr key={i.id}>
                  <Td className="font-bold">{i.name}</Td>
                  <Td className="font-mono">KES {money(Number(i.outstanding))}</Td>
                  <Td className="text-slate-400">
                    {i.last_payment_at ? new Date(i.last_payment_at).toLocaleDateString() : '—'}
                  </Td>
                  <Td><Badge value={i.status} /></Td>
                  <Td>
                    <Link to={`/admin/isps/${i.id}`}>
                      <ArrowUpRight className="w-4 h-4 text-slate-400 hover:text-violet-600" />
                    </Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

<Card>
        <CardHeader
          title="All ISPs"
          subtitle={`${totals.tenants} tenant${totals.tenants === 1 ? '' : 's'}`}
          icon={<Building2 className="w-4 h-4" />}
        />
        <Table>
          <thead>
            <tr>
              <Th>ISP</Th><Th>Location</Th><Th>Status</Th><Th>Plan</Th>
              <Th>Customers</Th><Th>Nodes</Th><Th>Revenue 30d</Th><Th />
            </tr>
          </thead>
          <tbody>
            {isps.map((i) => (
              <tr key={i.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition">
                <Td>
                  <div className="flex items-center gap-2.5">
                    <span
                      className="w-7 h-7 rounded-lg grid place-items-center text-white text-[10px] font-black shrink-0"
                      style={{ backgroundColor: i.brand_color }}
                    >
                      {i.name.slice(0, 2).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <p className="font-bold text-slate-800 dark:text-white truncate">{i.name}</p>
                      <p className="text-[10px] text-slate-400 font-mono truncate">{i.slug}.portal</p>
                    </div>
                  </div>
                </Td>
                <Td className="text-slate-400">
                  <span className="inline-flex items-center gap-1"><Globe className="w-3 h-3" /> {i.city ?? '—'}</span>
                </Td>
                <Td><Badge value={i.status} /></Td>
                <Td><Badge value={i.plan} /></Td>
                <Td className="font-mono">
                  {i.active_clients}<span className="text-slate-400"> / {i.max_clients}</span>
                </Td>
                <Td>
                  <span className="inline-flex items-center gap-1 font-mono">
                    <Radio className="w-3 h-3 text-emerald-500" /> {i.nodes_online}
                  </span>
                </Td>
                <Td className="font-mono font-bold">KES {money(Number(i.revenue_30d))}</Td>
                <Td>
                  <Link to={`/admin/isps/${i.id}`}>
                    <ArrowUpRight className="w-4 h-4 text-slate-400 hover:text-violet-600" />
                  </Link>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  )
}