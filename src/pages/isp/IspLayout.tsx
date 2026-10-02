import { useState } from 'react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import {
  Wifi, ShieldCheck, LogOut, Moon, Sun, Menu, X, Globe, AlertTriangle,
  LayoutDashboard, Users, Package, Ticket as TicketIcon, Radio as RadioIcon,
  CreditCard, Receipt, RefreshCw, ArrowLeftRight, MessageSquare, Percent,
  Wallet, Boxes, BarChart3, Settings, Plug, ScrollText,
} from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { usePanel } from '../../context/PanelContext'
import { useTenant } from '../../context/TenantContext'
import { useTheme } from '../../context/ThemeContext'
import { config } from '../../lib/config'
import { cn } from '../../utils/cn'
const CardIcon = CreditCard

const GROUPS: Array<{ label: string; items: Array<{ to: string; label: string; icon: typeof Users; badge?: 'tickets' | 'sms' | 'resellers' | 'inventory' }> }> = [
  { label: 'Dashboard', items: [{ to: '/app', label: 'Overview', icon: LayoutDashboard }] },
  { label: 'Customers', items: [
    { to: '/app/customers', label: 'All Customers', icon: Users },
    { to: '/app/sessions', label: 'Online Users', icon: RadioIcon },
    { to: '/app/tickets', label: 'Tickets', icon: TicketIcon, badge: 'tickets' },
  ] },
  { label: 'Services', items: [
    { to: '/app/packages', label: 'Packages', icon: Package },
    { to: '/app/hotspot', label: 'HotSpot', icon: Wifi },
    { to: '/app/vouchers', label: 'Vouchers', icon: TicketIcon },
    { to: '/app/pppoe', label: 'PPPoE', icon: Plug },
  ] },
  { label: 'Network', items: [
    { to: '/app/routers', label: 'Routers', icon: RadioIcon },
    { to: '/app/provision', label: 'Add MikroTik', icon: Plug },
    { to: '/app/status', label: 'Network Status', icon: RadioIcon },
  ] },
  { label: 'Billing', items: [
    { to: '/app/payments', label: 'Payments', icon: CreditCard },
    { to: '/app/invoices', label: 'Invoices', icon: Receipt },
    { to: '/app/renewals', label: 'Renewals', icon: RefreshCw },
    { to: '/app/transactions', label: 'Transactions', icon: ArrowLeftRight },
  ] },
  { label: 'Communication', items: [
    { to: '/app/sms', label: 'SMS', icon: MessageSquare, badge: 'sms' },
  ] },
  { label: 'Sales', items: [
    { to: '/app/resellers', label: 'Resellers', icon: Percent, badge: 'resellers' },
    { to: '/app/commissions', label: 'Commissions', icon: Percent },
  ] },
  { label: 'Business', items: [
    { to: '/app/expenses', label: 'Expenses', icon: Wallet },
    { to: '/app/inventory', label: 'Inventory', icon: Boxes, badge: 'inventory' },
    { to: '/app/reports', label: 'Reports', icon: BarChart3 },
  ] },
  { label: 'Team', items: [
    { to: '/app/staff', label: 'Staff', icon: Users },
    { to: '/app/roles', label: 'Roles', icon: ShieldCheck },
  ] },
  { label: 'Settings', items: [
    { to: '/app/settings', label: 'ISP Settings', icon: Settings },
    { to: '/app/settings/portal', label: 'Captive Portal', icon: Globe },
    { to: '/app/settings/payment', label: 'Payment Settings', icon: CardIcon },
    { to: '/app/settings/network', label: 'Network Settings', icon: RadioIcon },
    { to: '/app/settings/sms', label: 'SMS Settings', icon: MessageSquare },
    { to: '/app/audit', label: 'Audit Log', icon: ScrollText },
  ] },
]


export default function IspLayout() {
  const { user, signOut } = useAuth()
  const { nodes, loading } = useTenant()
  const { stats } = usePanel()
  const { darkMode, toggleTheme } = useTheme()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)

  const isp = user?.isp
  const online = nodes.filter((n) => n.status === 'online').length

  const badgeCount = (b?: string) => {
    if (!b || !stats) return 0
    return { tickets: stats.tickets_open, sms: stats.sms_month,
      resellers: stats.resellers_active, inventory: stats.inventory_low }[b] ?? 0
  }

  async function logout() {
    await signOut()
    navigate('/login', { replace: true })
  }

  return (
    <div className={cn('min-h-screen flex',
      darkMode ? 'bg-slate-950 text-slate-200' : 'bg-slate-50 text-slate-800')}>
      {/* Sidebar */}
      <aside className={cn(
        'fixed lg:sticky top-0 h-screen w-60 shrink-0 z-50 flex flex-col bg-slate-900 text-white transition-transform lg:translate-x-0',
        menuOpen ? 'translate-x-0' : '-translate-x-full')}>
        <div className="p-4 border-b border-slate-800 flex items-center justify-between gap-2">
          <Link to="/app" className="flex items-center gap-2.5 min-w-0">
            <span className="h-9 w-9 rounded-lg grid place-items-center shrink-0"
              style={{ backgroundColor: isp?.brand_color ?? '#7c3aed' }}>
              <Wifi className="w-4 h-4 text-white stroke-[2.5]" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-black truncate">{isp?.name ?? 'ISP'}</p>
              <p className="text-[9px] text-slate-400 font-mono uppercase truncate">{isp?.plan} plan</p>
            </div>
          </Link>
          <button onClick={() => setMenuOpen(false)} className="lg:hidden text-slate-400"><X className="w-5 h-5" /></button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-4">
          {GROUPS.map((g) => (
            <div key={g.label}>
              <p className="px-3 mb-1 text-[9px] font-bold text-slate-500 uppercase tracking-widest font-mono">{g.label}</p>
              <div className="space-y-0.5">
                {g.items.map((item) => {
                  const count = badgeCount(item.badge)
                  return (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.to === '/app'}
                      onClick={() => setMenuOpen(false)}
                      className={({ isActive }) => cn(
                        'flex items-center gap-2.5 px-3 py-2 rounded-lg text-[11px] font-bold transition',
                        isActive ? 'bg-violet-600 text-white shadow-lg'
                               : 'text-slate-400 hover:bg-slate-800 hover:text-white')}>
                      <item.icon className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate flex-1">{item.label}</span>
                      {count > 0 && (
                        <span className="px-1.5 rounded bg-slate-700 text-slate-200 text-[9px] font-mono">{count}</span>
                      )}
                    </NavLink>
                  )
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="p-3 border-t border-slate-800 space-y-2">
          <div className="flex items-center gap-2 px-2">
            <span className={`w-2 h-2 rounded-full ${config.mode === 'live' ? 'bg-emerald-400' : 'bg-amber-400'}`} />
            <span className="text-[9px] text-slate-400 font-mono">{config.mode === 'live' ? 'Supabase' : 'Demo mode'}</span>
            {!loading && <span className="ml-auto text-[9px] text-slate-500 font-mono">Routers {online}/{nodes.length}</span>}
          </div>
          <div className="flex gap-1">
            <button onClick={toggleTheme} className="flex-1 p-2 rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white">
              {darkMode ? <Moon className="w-3.5 h-3.5 mx-auto" /> : <Sun className="w-3.5 h-3.5 mx-auto" />}
            </button>
            <Link to={`/portal/${isp?.slug ?? ''}`} className="flex-1 p-2 rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white">
              <Globe className="w-3.5 h-3.5 mx-auto" />
            </Link>
            <button onClick={logout} className="flex-1 p-2 rounded-lg text-rose-400 hover:bg-rose-500/10">
              <LogOut className="w-3.5 h-3.5 mx-auto" />
            </button>
          </div>
        </div>
      </aside>

      {menuOpen && <div className="fixed inset-0 bg-black/50 z-40 lg:hidden" onClick={() => setMenuOpen(false)} />}

      <div className="flex-1 min-w-0">
        <header className="lg:hidden sticky top-0 z-30 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-4 py-3 flex items-center gap-3">
          <button onClick={() => setMenuOpen(true)} className="text-slate-500"><Menu className="w-5 h-5" /></button>
          <span className="text-sm font-black truncate">{isp?.name}</span>
        </header>

        {isp?.status === 'suspended' && (
          <div className="bg-amber-500/15 border-b border-amber-500/30 px-4 py-2.5 text-xs text-amber-800 dark:text-amber-300 flex items-center justify-center gap-2">
            <AlertTriangle className="w-4 h-4" />
            <strong>This workspace is suspended.</strong>
            <span className="hidden sm:inline">Contact the platform operator.</span>
          </div>
        )}

        <main className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
