import { useEffect, type ReactNode } from 'react'
import { cn } from '../../utils/cn'
import { Loader2, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn(
      'rounded-2xl border shadow-sm transition-colors duration-300',
      'bg-white border-slate-200 dark:bg-slate-900 dark:border-slate-800',
      className,
    )}>
      {children}
    </div>
  )
}

export function CardHeader({
  title, subtitle, icon, action,
}: { title: string; subtitle?: string; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-slate-200 dark:border-slate-800">
      <div className="flex items-start gap-3 min-w-0">
        {icon && <div className="shrink-0 text-violet-600 dark:text-violet-400 mt-0.5">{icon}</div>}
        <div className="min-w-0">
          <h2 className="text-sm font-black tracking-tight text-slate-900 dark:text-white">{title}</h2>
          {subtitle && (
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">{subtitle}</p>
          )}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

export function StatTile({
  label, value, hint, icon, tone = 'violet',
}: {
  label: string
  value: string | number
  hint?: string
  icon?: ReactNode
  tone?: 'violet' | 'emerald' | 'amber' | 'sky' | 'rose' | 'slate'
}) {
  const tones = {
    violet: 'bg-violet-50 text-violet-600 dark:bg-violet-500/10 dark:text-violet-400',
    emerald: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400',
    amber: 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400',
    sky: 'bg-sky-50 text-sky-600 dark:bg-sky-500/10 dark:text-sky-400',
    rose: 'bg-rose-50 text-rose-600 dark:bg-rose-500/10 dark:text-rose-400',
    slate: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  }
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="text-[10px] font-bold text-slate-400 uppercase font-mono tracking-wider block">
            {label}
          </span>
          <span className="block mt-1 text-2xl font-black tracking-tight text-slate-900 dark:text-white font-mono">
            {value}
          </span>
          {hint && <span className="block mt-1 text-[11px] text-slate-500 dark:text-slate-400">{hint}</span>}
        </div>
        {icon && <div className={cn('p-2 rounded-xl shrink-0', tones[tone])}>{icon}</div>}
      </div>
    </Card>
  )
}

const BADGE_TONES: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  trial: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  suspended: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  churned: 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
  starter: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  growth: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
  enterprise: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  paid: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  unpaid: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  overdue: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
  cancelled: 'bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-400',
  unused: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  expired: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
  disabled: 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
  open: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  in_progress: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  resolved: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  closed: 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
  online: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  offline: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
  maintenance: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  success: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  failed: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
  pending: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  reversed: 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
  ready: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  not_configured: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
}

export function Badge({ value, className }: { value: string; className?: string }) {
  return (
    <span className={cn(
      'inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wide font-mono whitespace-nowrap',
      BADGE_TONES[value] ?? 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
      className,
    )}>
      {value.replace(/_/g, ' ')}
    </span>
  )
}

export function Button({
  children, onClick, variant = 'primary', size = 'md',
  disabled, loading, type = 'button', className, icon,
}: {
  children?: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'success'
  size?: 'sm' | 'md'
  disabled?: boolean
  loading?: boolean
  type?: 'button' | 'submit'
  className?: string
  icon?: ReactNode
}) {
  const variants = {
    primary: 'bg-gradient-to-r from-violet-600 to-indigo-600 text-white hover:from-violet-500 hover:to-indigo-500 shadow-sm',
    secondary: 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-700',
    ghost: 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
    danger: 'bg-rose-600 text-white hover:bg-rose-500',
    success: 'bg-emerald-600 text-white hover:bg-emerald-500',
  }
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-xl font-bold transition-all',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        size === 'sm' ? 'px-3 py-1.5 text-[11px]' : 'px-4 py-2.5 text-xs',
        variants[variant],
        className,
      )}
    >
      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : icon}
      {children}
    </button>
  )
}

/**
 * Labelled form control.
 *
 * By default the label wraps the control, which is correct for inputs. For a
 * group of buttons/toggles pass `group` — a <label> must not wrap a button
 * group, and it would otherwise leak into each button's accessible name.
 */
export function Field({
  label, children, hint, group,
}: { label: string; children: ReactNode; hint?: string; group?: boolean }) {
  const control = group ? (
    <div role="group" aria-label={label}>
      <span className="block text-[11px] font-bold text-slate-500 dark:text-slate-400 mb-1.5 uppercase tracking-wide">
        {label}
      </span>
      {children}
    </div>
  ) : (
    <label className="block">
      <span className="block text-[11px] font-bold text-slate-500 dark:text-slate-400 mb-1.5 uppercase tracking-wide">
        {label}
      </span>
      {children}
    </label>
  )

  return hint ? (
    <div>
      {control}
      <span className="block text-[10px] text-slate-400 mt-1">{hint}</span>
    </div>
  ) : control
}

export const inputClass =
  'w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 ' +
  'placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 ' +
  'focus:border-violet-500 transition dark:bg-slate-800 dark:border-slate-700 dark:text-white'

export function Alert({
  kind, children,
}: {
  kind: 'error' | 'success' | 'warning' | 'info'
  children: ReactNode
}) {
  const styles = {
    error: 'bg-rose-50 border-rose-200 text-rose-800 dark:bg-rose-500/10 dark:border-rose-500/30 dark:text-rose-300',
    success: 'bg-emerald-50 border-emerald-200 text-emerald-800 dark:bg-emerald-500/10 dark:border-emerald-500/30 dark:text-emerald-300',
    warning: 'bg-amber-50 border-amber-200 text-amber-900 dark:bg-amber-500/10 dark:border-amber-500/30 dark:text-amber-200',
    info: 'bg-sky-50 border-sky-200 text-sky-900 dark:bg-sky-500/10 dark:border-sky-500/30 dark:text-sky-200',
  }
  const icons = {
    error: <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />,
    success: <CheckCircle2 className="w-4 h-4 shrink-0 mt-px" />,
    warning: <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />,
    info: <Info className="w-4 h-4 shrink-0 mt-px" />,
  }
  return (
    <div className={cn(
      'flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-xs border',
      styles[kind],
    )}>
      {icons[kind]}
      <span className="leading-relaxed">{children}</span>
    </div>
  )
}

export function EmptyState({ icon, title, hint }: { icon?: ReactNode; title: string; hint?: string }) {
  return (
    <div className="py-14 text-center">
      {icon && <div className="text-slate-300 dark:text-slate-600 mb-3 flex justify-center">{icon}</div>}
      <p className="text-sm font-bold text-slate-600 dark:text-slate-300">{title}</p>
      {hint && <p className="text-[11px] text-slate-400 mt-1 max-w-sm mx-auto">{hint}</p>}
    </div>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-slate-400">
      <Loader2 className="w-5 h-5 animate-spin" />
      {label && <span className="text-xs font-medium">{label}</span>}
    </div>
  )
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs border-collapse">{children}</table>
    </div>
  )
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <th className={cn(
      'px-4 py-2.5 font-bold text-[10px] uppercase tracking-wider text-slate-400 font-mono',
      'border-b border-slate-200 dark:border-slate-800 whitespace-nowrap', className,
    )}>
      {children}
    </th>
  )
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <td className={cn(
      'px-4 py-3 text-slate-700 dark:text-slate-300 border-b border-slate-100 dark:border-slate-800/70',
      className,
    )}>
      {children}
    </td>
  )
}
/**
 * Centred dialog used for forms. Closes on Escape or a backdrop click.
 */
export function Modal({
  open, onClose, title, children,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="my-8 w-full max-w-lg rounded-2xl bg-white shadow-2xl dark:bg-slate-900 dark:ring-1 dark:ring-slate-800"
      >
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <h2 className="text-sm font-black text-slate-900 dark:text-white">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  )
}
