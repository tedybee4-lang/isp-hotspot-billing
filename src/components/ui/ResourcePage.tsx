/**
 * Reusable list screen: search, status filter, sort, pagination.
 *
 * Every panel section renders real rows from the tenant data layer — there is
 * no placeholder data anywhere in the app.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Search, Inbox, ChevronLeft, ChevronRight } from 'lucide-react'
import { Card, Badge, EmptyState, Spinner, Table, Td, Th, inputClass } from './index'
import { cn } from '../../utils/cn'

export interface Column<T> {
  key: string
  header: string
  cell: (row: T) => ReactNode
  sort?: (row: T) => string | number
  className?: string
}

interface ResourcePageProps<T> {
  title: string
  subtitle?: string
  icon?: ReactNode
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string
  loading?: boolean
  emptyTitle?: string
  emptyHint?: string
  statusField?: string
  statusOptions?: string[]
  searchFields?: (row: T) => string[]
  actions?: ReactNode
  summary?: ReactNode
  pageSize?: number
}

export function ResourcePage<T>({
  title, subtitle, icon, rows, columns, rowKey, loading,
  emptyTitle = 'Nothing here yet', emptyHint,
  statusField, statusOptions, searchFields, actions, summary, pageSize = 25,
}: ResourcePageProps<T>) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [asc, setAsc] = useState(true)
  const [page, setPage] = useState(0)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let out = rows
    if (q && searchFields) {
      out = out.filter((r) => searchFields(r).some((f) => f.toLowerCase().includes(q)))
    }
    if (status !== 'all' && statusField) {
      out = out.filter((r) => String((r as Record<string, unknown>)[statusField]) === status)
    }
    const col = sortKey ? columns.find((c) => c.key === sortKey) : null
    if (col?.sort) {
      out = [...out].sort((a, b) => {
        const av = col.sort!(a); const bv = col.sort!(b)
        const cmp = typeof av === 'number' && typeof bv === 'number'
          ? av - bv : String(av).localeCompare(String(bv))
        return asc ? cmp : -cmp
      })
    }
    return out
  }, [rows, query, status, sortKey, asc, columns, searchFields, statusField])

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const current = Math.min(page, pages - 1)
  const slice = filtered.slice(current * pageSize, (current + 1) * pageSize)

  function toggleSort(key: string) {
    if (sortKey === key) setAsc((v) => !v)
    else { setSortKey(key); setAsc(true) }
    setPage(0)
  }

  if (loading) return <Spinner label={`Loading ${title.toLowerCase()}...`} />

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-start gap-3">
          {icon && <span className="text-violet-600 dark:text-violet-400 mt-0.5">{icon}</span>}
          <div>
            <h1 className="text-xl font-black tracking-tight text-slate-900 dark:text-white">{title}</h1>
            {subtitle && <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{subtitle}</p>}
          </div>
        </div>
        {actions}
      </div>

      {summary}

      <Card>
        <div className="p-4 flex flex-wrap items-center gap-3 border-b border-slate-200 dark:border-slate-800">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(e) => { setQuery(e.target.value); setPage(0) }}
              placeholder="Search..."
              className={cn(inputClass, 'pl-9')}
            />
          </div>
          {statusOptions && statusField && (
            <div className="flex gap-1 p-1 rounded-xl bg-slate-100 dark:bg-slate-800">
              {['all', ...statusOptions].map((s) => (
                <button
                  key={s}
                  onClick={() => { setStatus(s); setPage(0) }}
                  className={cn(
                    'px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition',
                    status === s
                      ? 'bg-white dark:bg-slate-700 text-violet-600 dark:text-violet-300 shadow-sm'
                      : 'text-slate-500 dark:text-slate-400',
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          <span className="ml-auto text-[11px] text-slate-400 font-mono">
            {filtered.length} record{filtered.length === 1 ? '' : 's'}
          </span>
        </div>

        {slice.length === 0 ? (
          <EmptyState icon={<Inbox className="w-10 h-10" />} title={emptyTitle} hint={emptyHint} />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  {columns.map((c) => (
                    <Th key={c.key} className={cn(c.sort && 'cursor-pointer select-none', c.className)}>
                      <button
                        type="button"
                        disabled={!c.sort}
                        onClick={() => c.sort && toggleSort(c.key)}
                        className="inline-flex items-center gap-1 disabled:cursor-default"
                      >
                        {c.header}
                        {sortKey === c.key && <span className="text-violet-500">{asc ? '+' : '-'}</span>}
                      </button>
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {slice.map((row) => (
                  <tr key={rowKey(row)} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition">
                    {columns.map((c) => (
                      <Td key={c.key} className={c.className}>{c.cell(row)}</Td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </Table>

            {pages > 1 && (
              <div className="flex items-center justify-between px-4 py-3">
                <button disabled={current === 0} onClick={() => setPage(current - 1)}
                  className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-500 disabled:opacity-40 hover:text-violet-600">
                  <ChevronLeft className="w-3.5 h-3.5" /> Previous
                </button>
                <span className="text-[11px] font-mono text-slate-400">Page {current + 1} of {pages}</span>
                <button disabled={current >= pages - 1} onClick={() => setPage(current + 1)}
                  className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-500 disabled:opacity-40 hover:text-violet-600">
                  Next <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  )
}

export const StatusCell = ({ value }: { value: string }) => <Badge value={value} />

export const Money = ({ value }: { value: number | string | null }) => (
  <span className="font-mono font-bold">
    KES {Number(value ?? 0).toLocaleString('en', { maximumFractionDigits: 0 })}
  </span>
)

export const When = ({ value }: { value: string | null }) => (
  <span className="font-mono text-[10px] text-slate-400">
    {value ? new Date(value).toLocaleString() : '--'}
  </span>
)
