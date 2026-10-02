import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import {
  ShieldCheck, LayoutDashboard, Building2, ScrollText, LogOut,
  Moon, Sun, Menu, X, Wifi, CreditCard,
} from 'lucide-react'
import { useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useTheme } from '../../context/ThemeContext'
import { config } from '../../lib/config'
import { cn } from '../../utils/cn'

const NAV = [
  { to: '/admin', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/admin/isps', label: 'ISPs', icon: Building2 },
  { to: '/admin/payments', label: 'Payments', icon: CreditCard },
  { to: '/admin/audit', label: 'Audit log', icon: ScrollText },
]

export default function AdminLayout() {
  const { user, signOut } = useAuth()
  const { darkMode, toggleTheme } = useTheme()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  async function logout() {
    await signOut()
    navigate('/login', { replace: true })
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex">
      {/* Sidebar */}
      <aside className={cn(
        'fixed lg:sticky top-0 h-screen w-64 shrink-0 z-50 flex flex-col',
        'bg-slate-900 border-r border-slate-800 text-white',
        'transition-transform lg:translate-x-0',
        open ? 'translate-x-0' : '-translate-x-full',
      )}>
        <div className="p-5 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 bg-gradient-to-tr from-violet-600 to-cyan-500 rounded-lg flex items-center justify-center">
              <Wifi className="w-5 h-5 stroke-[2.5]" />
            </div>
            <div>
              <h1 className="text-base font-black tracking-tight">
                ISP<span className="text-cyan-400">Flow</span>
              </h1>
              <span className="text-[9px] text-violet-300 font-mono tracking-widest uppercase block">
                Super Admin
              </span>
            </div>
          </div>
          <button onClick={() => setOpen(false)} className="lg:hidden text-slate-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              onClick={() => setOpen(false)}
              className={({ isActive }) => cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs font-bold transition',
                isActive
                  ? 'bg-violet-600 text-white shadow-lg shadow-violet-900/40'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-white',
              )}
            >
              <item.icon className="w-4 h-4 shrink-0" />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="p-3 border-t border-slate-800 space-y-2">
          <div className="flex items-center gap-2 px-3 py-2">
            <span className={`w-2 h-2 rounded-full ${config.mode === 'live' ? 'bg-emerald-400' : 'bg-amber-400'}`} />
            <span className="text-[10px] text-slate-400 font-mono">
              {config.mode === 'live' ? 'Supabase connected' : 'Demo mode'}
            </span>
          </div>
          <div className="px-3 py-2 rounded-xl bg-slate-800/60">
            <p className="text-[11px] font-bold text-white truncate">{user?.profile.full_name}</p>
            <p className="text-[10px] text-slate-400 font-mono truncate">{user?.email}</p>
          </div>
          <div className="flex gap-1">
            <button
              onClick={toggleTheme}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[11px] text-slate-400 hover:bg-slate-800 hover:text-white transition"
            >
              {darkMode ? <Moon className="w-3.5 h-3.5" /> : <Sun className="w-3.5 h-3.5" />}
            </button>
            <button
              onClick={logout}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[11px] text-rose-400 hover:bg-rose-500/10 transition"
            >
              <LogOut className="w-3.5 h-3.5" /> Sign out
            </button>
          </div>
        </div>
      </aside>

      {open && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Content */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="lg:hidden sticky top-0 z-30 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-4 py-3 flex items-center gap-3">
          <button onClick={() => setOpen(true)} className="text-slate-500 dark:text-slate-300">
            <Menu className="w-5 h-5" />
          </button>
          <span className="text-sm font-black tracking-tight text-slate-900 dark:text-white">
            <ShieldCheck className="w-4 h-4 inline text-violet-600 mr-1.5" />
            Super Admin
          </span>
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}