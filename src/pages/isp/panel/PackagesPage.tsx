/**
 * ISP package management.
 *
 * This page exists because the packages a customer sees on the captive portal
 * were not editable. The table used to render `useTenant().plans` read-only:
 * an ISP could see its catalogue but not change a price, a speed, a duration,
 * or whether a package was offered at all. Every field below writes to the
 * `plans` row, so the portal, the RADIUS profile and the payment amount all
 * follow automatically. There is no second copy of a package anywhere.
 *
 * Two rules shape the implementation:
 *
 *  1. THE DATABASE IS THE SOURCE OF TRUTH. The form sends the plan id and the
 *     fields the ISP changed. It never sends a price that the backend then
 *     believes, because `portal_create_payment` re-reads the plan row itself
 *     and derives the M-Pesa amount from it. Editing a price here changes what
 *     the NEXT customer is charged, not what an in-flight one was charged.
 *
 *  2. ACTIVE, VISIBLE AND DELETED ARE THREE DIFFERENT THINGS.
 *       is_active      = false -> cannot be bought, at all
 *       show_on_portal = false -> simply not listed
 *       delete         -> only when nothing references it, and the server
 *                         refuses otherwise
 *     A package with paying customers is archived (deactivated), never deleted,
 *     so payment history keeps its meaning.
 *
 * Tenant scoping is never taken from the browser: `create_plan`, `update_plan`
 * and `delete_plan` each resolve the ISP from the caller's session, so the ids
 * in this file only ever select WHICH package, never WHICH tenant.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowDown, ArrowUp, Eye, EyeOff, Pencil, Plus, Trash2,
} from 'lucide-react'
import { useTenant } from '../../../context/TenantContext'
import * as api from '../../../lib/data'
import type { Plan } from '../../../lib/types'
import {
  Button, Field, Modal, Table, Td, Th, Alert, EmptyState, Spinner, inputClass,
} from '../../../components/ui'

const KINDS = [
  { value: 'hotspot', label: 'HotSpot' },
  { value: 'pppoe', label: 'PPPoE' },
  { value: 'fiber', label: 'Fiber' },
] as const

/** A blank row for the create form. Every field the RPC requires has a value. */
const BLANK = {
  name: '',
  kind: 'hotspot' as Plan['kind'],
  duration_label: '1 Hour',
  duration_hours: 1,
  price: 0,
  speed_down: '',
  speed_up: '',
  data_limit: 'Unlimited',
  fup: '',
  shared_users: 1,
  description: '',
  is_active: true,
  is_popular: false,
  show_on_portal: true,
}

type Draft = typeof BLANK

const toDraft = (p: Plan): Draft => ({
  name: p.name,
  kind: p.kind,
  duration_label: p.duration_label,
  duration_hours: p.duration_hours,
  price: Number(p.price),
  speed_down: p.speed_down,
  speed_up: p.speed_up,
  data_limit: p.data_limit ?? '',
  fup: p.fup ?? '',
  shared_users: p.shared_users,
  description: p.description ?? '',
  is_active: p.is_active,
  is_popular: p.is_popular,
  show_on_portal: p.show_on_portal ?? true,
})

export function PackagesPage() {
  const { plans, loading, reload } = useTenant()
  const [editing, setEditing] = useState<Plan | null>(null)
  const [creating, setCreating] = useState(false)
  const [order, setOrder] = useState<string[]>([])
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  // The display order lives on the tenant's portal settings, not on the plan
  // rows, because it is a property of the storefront rather than of a package.
  const loadOrder = useCallback(async () => {
    try {
      const settings = await api.fetchPortalSettings()
      setOrder(settings?.package_order ?? [])
    } catch {
      // An ISP with no settings row yet simply has no saved order; the list
      // falls back to its natural order below.
      setOrder([])
    }
  }, [])

  useEffect(() => { void loadOrder() }, [loadOrder])

  /**
   * The rows exactly as the portal will render them: anything the ISP has
   * positioned first, then the rest. Mirrors the ORDER BY in
   * public_portal_packages so the dashboard never disagrees with the storefront.
   */
  const rows = useMemo(() => {
    const byId = new Map(plans.map((p) => [p.id, p]))
    const ranked = order.filter((id) => byId.has(id)).map((id) => byId.get(id)!)
    const rest = plans.filter((p) => !order.includes(p.id))
    return [...ranked, ...rest]
  }, [plans, order])

  const live = rows.filter((p) => p.is_active && (p.show_on_portal ?? true))

  /** Runs a mutation, surfaces the server's message, then refreshes. */
  const run = async (action: () => Promise<void>, success: string) => {
    setBusy(true)
    setNotice(null)
    try {
      await action()
      await reload()
      await loadOrder()
      setNotice({ kind: 'success', text: success })
    } catch (err) {
      // The RPCs raise plain-English messages ("Package price cannot be
      // negative"), so they are shown verbatim rather than replaced with a
      // generic failure the ISP cannot act on.
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  const save = async (draft: Draft, id: string | null) => {
    await run(async () => {
      if (id) await api.updatePlan(id, draft)
      else await api.createPlan(draft)
    }, id ? 'Package updated.' : 'Package created.')
    setEditing(null)
    setCreating(false)
  }

  const move = async (index: number, direction: -1 | 1) => {
    const next = rows.map((p) => p.id)
    const target = index + direction
    if (target < 0 || target >= next.length) return
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved)
    setOrder(next)
    // Persisted immediately: reordering is a storefront decision, and the next
    // customer to load the page must see it without anyone pressing Save.
    await run(() => api.savePortalSettings({ package_order: next }), 'Display order saved.')
  }

  const togglePortal = (plan: Plan) =>
    run(
      () => api.updatePlan(plan.id, { show_on_portal: !(plan.show_on_portal ?? true) }),
      plan.show_on_portal ? 'Hidden from the captive portal.' : 'Now visible on the captive portal.',
    )

  const toggleActive = (plan: Plan) =>
    run(
      () => api.updatePlan(plan.id, { is_active: !plan.is_active }),
      plan.is_active ? 'Package deactivated. Customers cannot buy it.' : 'Package activated.',
    )

  const remove = (plan: Plan) =>
    run(() => api.deletePlan(plan.id), `Deleted "${plan.name}".`)

  if (loading) return <Spinner label="Loading packages..." />

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">
            Packages
          </h1>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {plans.length} in this catalogue &middot; {live.length} currently offered on the captive
            portal. Changes apply to the next purchase with no redeployment.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreating(true)} icon={<Plus className="h-3.5 w-3.5" />}>
          New package
        </Button>
      </div>

      {notice && (
        <Alert kind={notice.kind}>
          <span className="flex items-start justify-between gap-3">
            <span>{notice.text}</span>
            <button onClick={() => setNotice(null)} aria-label="Dismiss">
              &times;
            </button>
          </span>
        </Alert>
      )}

      {live.length === 0 && plans.length > 0 && (
        <Alert kind="warning">
          None of your packages are currently offered on the captive portal, so customers see
          &ldquo;No packages are currently available.&rdquo; Turn a package on, or mark it visible,
          to start selling.
        </Alert>
      )}

      {plans.length === 0 ? (
        <EmptyState
          title="No packages defined"
          hint="Create your first package to put prices on the captive portal."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Order</Th>
              <Th>Package</Th>
              <Th>Price</Th>
              <Th>Speed</Th>
              <Th>Duration</Th>
              <Th>Sellable</Th>
              <Th>On portal</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((plan, index) => (
              <tr key={plan.id} data-testid={`plan-${plan.id}`}>
                <Td>
                  <OrderButtons
                    name={plan.name}
                    canUp={index > 0}
                    canDown={index < rows.length - 1}
                    disabled={busy}
                    onUp={() => void move(index, -1)}
                    onDown={() => void move(index, 1)}
                  />
                </Td>
                <Td>
                  <div className="font-bold text-slate-800 dark:text-white">{plan.name}</div>
                  <div className="text-[10px] uppercase tracking-wide text-slate-400">
                    {plan.kind}
                  </div>
                </Td>
                <Td>
                  <span className="font-mono font-bold">
                    KES {Number(plan.price).toLocaleString('en', { maximumFractionDigits: 0 })}
                  </span>
                </Td>
                <Td>
                  <span className="font-mono text-[10px]">
                    {plan.speed_down}
                    {plan.speed_up ? ` / ${plan.speed_up}` : ''}
                  </span>
                </Td>
                <Td>
                  <span className="text-[10px]">{plan.duration_label}</span>
                  <div className="text-[10px] text-slate-400">{plan.duration_hours}h</div>
                </Td>
                <Td>
                  <button
                    onClick={() => void toggleActive(plan)}
                    disabled={busy}
                    className="text-[10px] font-bold uppercase tracking-wide"
                  >
                    {plan.is_active ? (
                      <span className="text-emerald-600 dark:text-emerald-400">Active</span>
                    ) : (
                      <span className="text-slate-400">Inactive</span>
                    )}
                  </button>
                </Td>
                <Td>
                  <button
                    onClick={() => void togglePortal(plan)}
                    disabled={busy}
                    aria-label={plan.show_on_portal ? 'Hide from portal' : 'Show on portal'}
                    className="text-slate-500 hover:text-slate-900 dark:hover:text-white"
                  >
                    {plan.show_on_portal ? (
                      <Eye className="h-4 w-4" />
                    ) : (
                      <EyeOff className="h-4 w-4 text-slate-300 dark:text-slate-600" />
                    )}
                  </button>
                </Td>
                <Td>
                  <div className="flex items-center justify-end gap-1">
                    <button
                      onClick={() => {
                        setEditing(plan)
                        setCreating(false)
                      }}
                      aria-label={`Edit ${plan.name}`}
                      className="rounded p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => void remove(plan)}
                      disabled={busy}
                      aria-label={`Delete ${plan.name}`}
                      className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <PackageForm
        open={creating || editing !== null}
        title={editing ? `Edit ${editing.name}` : 'New package'}
        initial={editing ? toDraft(editing) : BLANK}
        busy={busy}
        onClose={() => {
          setCreating(false)
          setEditing(null)
        }}
        onSubmit={(draft) => void save(draft, editing?.id ?? null)}
      />
    </div>
  )
}

/** The up/down pair that sets this package's position on the portal grid. */
function OrderButtons({
  name, canUp, canDown, disabled, onUp, onDown,
}: {
  name: string
  canUp: boolean
  canDown: boolean
  disabled: boolean
  onUp: () => void
  onDown: () => void
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        onClick={onUp}
        disabled={disabled || !canUp}
        aria-label={`Move ${name} up`}
        className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"
      >
        <ArrowUp className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={onDown}
        disabled={disabled || !canDown}
        aria-label={`Move ${name} down`}
        className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"
      >
        <ArrowDown className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

/**
 * The create/edit form.
 *
 * Client-side checks are a convenience for the person typing, not a control:
 * the same rules run again in `validate_plan_fields` inside create_plan and
 * update_plan, so bypassing this form cannot create an invalid package.
 */
function PackageForm({
  open, title, initial, busy, onClose, onSubmit,
}: {
  open: boolean
  title: string
  initial: Draft
  busy: boolean
  onClose: () => void
  onSubmit: (draft: Draft) => void
}) {
  const [draft, setDraft] = useState<Draft>(initial)

  // Re-seed whenever the dialog opens for a different package, so a previous
  // edit never leaks into the next one.
  useEffect(() => { if (open) setDraft(initial) }, [open, initial])

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))

  const problem =
    !draft.name.trim() ? 'A package needs a name.'
    : draft.price < 0 ? 'The price cannot be negative.'
    : draft.duration_hours < 1 ? 'The duration must be at least 1 hour.'
    : !draft.speed_down.trim() ? 'A download speed is required, e.g. "5 Mbps".'
    : null

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (problem) return
          onSubmit({ ...draft, name: draft.name.trim(), price: Number(draft.price) })
        }}
      >
        <Field label="Package name">
          <input
            className={inputClass}
            value={draft.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="7 Days Unlimited"
            required
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Price (KES)">
            <input
              className={inputClass}
              type="number"
              min={0}
              step="0.01"
              value={draft.price}
              onChange={(e) => set('price', Number(e.target.value))}
              required
            />
          </Field>
          <Field label="Service type">
            <select
              className={inputClass}
              value={draft.kind}
              onChange={(e) => set('kind', e.target.value as Plan['kind'])}
            >
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>{k.label}</option>
              ))}
            </select>
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Download speed" hint='e.g. "5 Mbps", "512 Kbps"'>
            <input
              className={inputClass}
              value={draft.speed_down}
              onChange={(e) => set('speed_down', e.target.value)}
              placeholder="5 Mbps"
              required
            />
          </Field>
          <Field label="Upload speed" hint="Leave blank to match download">
            <input
              className={inputClass}
              value={draft.speed_up}
              onChange={(e) => set('speed_up', e.target.value)}
              placeholder="2 Mbps"
            />
          </Field>
        </div>

<div className="grid grid-cols-2 gap-3">
          <Field label="Duration label" hint="What the customer reads">
            <input
              className={inputClass}
              value={draft.duration_label}
              onChange={(e) => set('duration_label', e.target.value)}
              placeholder="7 Days"
              required
            />
          </Field>
          <Field label="Duration (hours)" hint="Sets the customer's expiry">
            <input
              className={inputClass}
              type="number"
              min={1}
              value={draft.duration_hours}
              onChange={(e) => set('duration_hours', Number(e.target.value))}
              required
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Devices allowed">
            <input
              className={inputClass}
              type="number"
              min={1}
              value={draft.shared_users}
              onChange={(e) => set('shared_users', Number(e.target.value))}
            />
          </Field>
          <Field label="Data allowance">
            <input
              className={inputClass}
              value={draft.data_limit}
              onChange={(e) => set('data_limit', e.target.value)}
              placeholder="Unlimited"
            />
          </Field>
        </div>

        <Field label="Description" hint="Shown on the package card">
          <textarea
            className={`${inputClass} min-h-[64px]`}
            value={draft.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="Best for heavy streaming at home."
          />
        </Field>

        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={draft.show_on_portal}
              onChange={(e) => set('show_on_portal', e.target.checked)}
            />
            Show on captive portal
          </label>
          <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={draft.is_active}
              onChange={(e) => set('is_active', e.target.checked)}
            />
            Active (purchasable)
          </label>
        </div>

        {problem && <Alert kind="error">{problem}</Alert>}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" type="submit" disabled={busy || problem !== null}>
            {title.startsWith('Edit') ? 'Save changes' : 'Create package'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}