/**
 * Captive portal management.
 *
 * Everything here is stored per ISP and read back by /portal/:slug, so one
 * tenant's branding can never appear on another's portal.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Save, RotateCcw, Eye, Palette, MessageSquare, Phone, ToggleLeft,
} from 'lucide-react'
import { useAuth } from '../../../context/AuthContext'
import * as api from '../../../lib/data'
import type { PortalSettings } from '../../../lib/data'
import {
  Card, CardHeader, Button, Field, Alert, Spinner, inputClass,
} from '../../../components/ui'
import { cn } from '../../../utils/cn'

type Draft = Omit<PortalSettings, 'isp_id' | 'updated_at'>

const EMPTY: Draft = {
  is_enabled: true,
  portal_name: '',
  welcome_message: '',
  terms_conditions: '',
  support_email: '',
  support_phone: '',
  support_whatsapp: '',
  logo_url: '',
  favicon_url: '',
  background_url: '',
  background_color: '#0f172a',
  primary_color: '#7c3aed',
  accent_color: '#22d3ee',
  login_method: 'both',
  show_packages: true,
  package_ids: [],
  payment_instructions: '',
  footer_text: '',
  social_links: {},
  hide_routeros: true,
  show_usage: true,
}

export function Toggle({
  label, value, onChange,
}: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 cursor-pointer">
      <span className="text-xs font-bold text-slate-700 dark:text-slate-200">{label}</span>
      <input
        type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-slate-300 text-violet-600"
      />
    </label>
  )
}

export function usePortalDraft() {
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const s = await api.fetchPortalSettings()
      if (s) {
        const { isp_id: _i, updated_at: _u, ...rest } = s
        void _i; void _u
        setDraft({ ...EMPTY, ...rest })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load portal settings.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }))

  async function save() {
    setSaving(true); setError(null); setNotice(null)
    try {
      await api.savePortalSettings(draft)
      setNotice('Published. Your captive portal now shows these settings.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.')
    } finally {
      setSaving(false)
    }
  }

  async function reset() {
    setSaving(true); setError(null); setNotice(null)
    try {
      await api.resetPortalSettings()
      await load()
      setNotice('Reset to the default design.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reset.')
    } finally {
      setSaving(false)
    }
  }

  return { draft, set, loading, saving, error, notice, save, reset, setError, setNotice }
}

export function CaptivePortalSettingsPage() {
  const { user } = useAuth()
  const s = usePortalDraft()
  const { draft, set, loading, saving, error, notice, save, reset } = s

  if (loading) return <Spinner label="Loading captive portal settings..." />

  const slug = user?.isp?.slug ?? ''

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-black tracking-tight text-slate-900 dark:text-white">
            Captive Portal
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Applies only to your portal at
            <span className="font-mono"> /portal/{slug}</span>.
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary"
            onClick={() => window.open(`/portal/${slug}`, '_blank')}
            icon={<Eye className="w-3.5 h-3.5" />}>
            Preview
          </Button>
          <Button size="sm" variant="secondary" onClick={reset} disabled={saving}
            icon={<RotateCcw className="w-3.5 h-3.5" />}>
            Reset
          </Button>
          <Button size="sm" onClick={save} disabled={saving} icon={<Save className="w-3.5 h-3.5" />}>
            {saving ? 'Publishing...' : 'Publish'}
          </Button>
        </div>
      </div>

      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      {!draft.is_enabled && (
        <Alert kind="warning">
          Your portal is switched off. Customers cannot log in until you enable it.
        </Alert>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <Card>
          <CardHeader title="Availability" icon={<ToggleLeft className="w-4 h-4" />} />
          <div className="p-5 space-y-4">
            <Toggle label="Portal enabled" value={draft.is_enabled}
              onChange={(v) => set('is_enabled', v)} />
            <Toggle label="Show packages on the portal" value={draft.show_packages}
              onChange={(v) => set('show_packages', v)} />
            <Toggle label='Hide "Powered by RouterOS"' value={draft.hide_routeros}
              onChange={(v) => set('hide_routeros', v)} />
            <Toggle label="Show live usage to customers" value={draft.show_usage}
              onChange={(v) => set('show_usage', v)} />
          </div>
        </Card>

        <Card>
          <CardHeader title="Login" icon={<MessageSquare className="w-4 h-4" />} />
          <div className="p-5 space-y-3">
            <div>
              <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300">
                Login method
              </span>
              <div className="mt-1 grid grid-cols-3 gap-1 p-1 rounded-xl bg-slate-100 dark:bg-slate-800">
                {(['voucher', 'customer', 'both'] as const).map((m) => (
                  <button key={m} onClick={() => set('login_method', m)}
                    className={cn(
                      'px-2 py-1.5 rounded-lg text-[11px] font-bold transition capitalize',
                      draft.login_method === m
                        ? 'bg-white dark:bg-slate-700 text-violet-600 shadow-sm'
                        : 'text-slate-500',
                    )}>
                    {m}
                  </button>
                ))}
              </div>
            </div>
            <Field label="Payment instructions">
              <textarea rows={3} className={inputClass}
                value={draft.payment_instructions ?? ''}
                onChange={(e) => set('payment_instructions', e.target.value)}
                placeholder="Pay to Till 123456 using your phone number as the account." />
            </Field>
          </div>
        </Card>
        {/* remaining cards appended below */}
        <Card>
          <CardHeader title="Branding" icon={<Palette className="w-4 h-4" />} />
          <div className="p-5 space-y-3">
            <Field label="Portal name">
              <input className={inputClass} value={draft.portal_name ?? ''}
                onChange={(e) => set('portal_name', e.target.value)}
                placeholder={user?.isp?.name ?? 'My Hotspot'} />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              {([
                ['primary_color', 'Primary'],
                ['accent_color', 'Accent'],
                ['background_color', 'Background'],
              ] as const).map(([k, label]) => (
                <Field key={k} label={label}>
                  <div className="flex gap-1">
                    <input type="color" value={draft[k] || '#000000'}
                      onChange={(e) => set(k, e.target.value)}
                      className="h-9 w-9 rounded border border-slate-200 dark:border-slate-700 bg-transparent" />
                    <input className={inputClass} value={draft[k] ?? ''}
                      onChange={(e) => set(k, e.target.value)} />
                  </div>
                </Field>
              ))}
            </div>
            <Field label="Logo URL">
              <input className={inputClass} value={draft.logo_url ?? ''}
                onChange={(e) => set('logo_url', e.target.value)} placeholder="https://..." />
            </Field>
            <Field label="Favicon URL">
              <input className={inputClass} value={draft.favicon_url ?? ''}
                onChange={(e) => set('favicon_url', e.target.value)} placeholder="https://..." />
            </Field>
            <Field label="Background image URL">
              <input className={inputClass} value={draft.background_url ?? ''}
                onChange={(e) => set('background_url', e.target.value)} placeholder="https://..." />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="Content" icon={<MessageSquare className="w-4 h-4" />} />
          <div className="p-5 space-y-3">
            <Field label="Welcome message">
              <textarea rows={2} className={inputClass}
                value={draft.welcome_message ?? ''}
                onChange={(e) => set('welcome_message', e.target.value)} />
            </Field>
            <Field label="Terms and conditions">
              <textarea rows={4} className={inputClass}
                value={draft.terms_conditions ?? ''}
                onChange={(e) => set('terms_conditions', e.target.value)} />
            </Field>
            <Field label="Footer text">
              <input className={inputClass} value={draft.footer_text ?? ''}
                onChange={(e) => set('footer_text', e.target.value)} />
            </Field>
          </div>
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader title="Support contact" icon={<Phone className="w-4 h-4" />} />
          <div className="p-5 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Support email">
              <input className={inputClass} value={draft.support_email ?? ''}
                onChange={(e) => set('support_email', e.target.value)} />
            </Field>
            <Field label="Support phone">
              <input className={inputClass} value={draft.support_phone ?? ''}
                onChange={(e) => set('support_phone', e.target.value)} />
            </Field>
            <Field label="WhatsApp">
              <input className={inputClass} value={draft.support_whatsapp ?? ''}
                onChange={(e) => set('support_whatsapp', e.target.value)}
                placeholder="+2547..." />
            </Field>
          </div>
        </Card>
      </div>
    </div>
  )
}