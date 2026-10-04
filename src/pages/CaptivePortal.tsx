/**
 * Public captive portal for one tenant, served at /portal/:slug.
 *
 * This is what a MikroTik hotspot redirects to when a device has no
 * connectivity, so it is a customer-facing storefront rather than a login box:
 * the packages are the product, and they come first. A portal that only offers
 * voucher entry hides the catalogue from every customer who would rather pay by
 * phone.
 *
 * Two constraints shape everything below:
 *
 *   * Nothing about the ISP is hardcoded. Name, logo, contact details, colours,
 *     links and every package come from the database, keyed on this slug, so two
 *     ISPs on the same deployment see two different portals.
 *   * Nothing about the PAYMENT is decided here. The page sends a slug, a plan
 *     id and a phone number, and the server returns the price. There is no
 *     amount, ISP id or account id anywhere in this file's request path.
 */
import {
  useCallback, useEffect, useMemo, useRef, useState,
  type FormEvent, type ReactNode,
} from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  CheckCircle2, ChevronDown, LifeBuoy, Loader2, Phone, RefreshCw, ShieldCheck,
  Ticket, User, Wifi,
} from 'lucide-react'
import {
  fetchPortalPackages, fetchPortalPaymentStatus, fetchPortalSettings,
  loginPortalCustomer, reconnectPortalCustomer, redeemPortalVoucher,
  startPortalPayment, PortalError,
  type PortalPackage, type PortalSettings,
} from '../lib/portal'
import { config } from '../lib/config'
import { loadDb } from '../lib/demoStore'
import type { Isp, Plan } from '../lib/types'
import { cn } from '../utils/cn'

/** Social networks the portal renders a label for, when the ISP configured one. */
const SOCIAL_LABELS: Record<string, string> = {
  whatsapp: 'WhatsApp', facebook: 'Facebook', instagram: 'Instagram',
  x: 'X', twitter: 'X', tiktok: 'TikTok', youtube: 'YouTube', linkedin: 'LinkedIn',
}

const QUICK_LINK_LABELS: Record<string, string> = {
  about: 'About Us', services: 'Our Services', faq: 'FAQ', support: 'Support',
}

/**
 * Reads the customer's MAC from the router's redirect, when it supplied one.
 *
 * Display only. It is never sent to the backend and never used for an
 * authorisation decision, because a client-supplied value cannot prove whose
 * device it is.
 */
function macFromLocation(): string | null {
  if (typeof window === 'undefined') return null
  const raw = new URLSearchParams(window.location.search).get('mac') ?? ''
  return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(raw.trim()) ? raw.trim().toUpperCase() : null
}

/** Turns a wa.me URL or a bare number into a link a phone can actually open. */
function whatsappHref(value: string | null | undefined): string | null {
  if (!value) return null
  const digits = value.replace(/\D/g, '')
  if (digits.length < 9) return null
  return digits.startsWith('254') ? `https://wa.me/${digits}` : `https://wa.me/254${digits}`
}

type Outcome = { ok: boolean; message: string } | null

interface PortalState {
  settings: PortalSettings
  packages: PortalPackage[]
}

export default function CaptivePortal() {
  const { slug } = useParams<{ slug: string }>()
  const [state, setState] = useState<PortalState | null>(null)
  const [missing, setMissing] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  // â”€â”€ Resolve the tenant from the slug â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  //
  // The slug identifies the ISP. Nothing about another tenant is ever requested,
  // and in live mode the demo store is not consulted at all: it only ever holds
  // the sample ISPs, so every real tenant resolved to "not found" in production
  // while looking correctly configured.
  useEffect(() => {
    let live = true
    void (async () => {
      setMissing(false)
      setLoadError(null)

      if (config.mode === 'live') {
        try {
          const settings = await fetchPortalSettings(slug!)
          if (!live) return
          if (!settings) { setMissing(true); return }

          // Packages load separately, and a failure there must not blank the
          // whole portal, so it is caught on its own.
          let packages: PortalPackage[] = []
          try {
            packages = await fetchPortalPackages(slug!)
          } catch {
            packages = []
          }
          if (!live) return
          setState({ settings, packages })
        } catch (e) {
          if (!live) return
          // A transport failure is not the same as "no such portal"; saying
          // "not found" would send the ISP hunting for a typo that is not there.
          setLoadError(
            e instanceof PortalError
              ? e.message
              : 'Could not reach this portal. Check your connection and try again.',
          )
        }
        return
      }

      // Demo mode, against the local store only.
      const db = loadDb()
      const isp = db.isps.find((i) => i.slug === slug)
      if (!isp) { setMissing(true); return }
      setState({ settings: demoSettings(isp), packages: demoPackages(db.plans, isp.id) })
    })()
    return () => { live = false }
  }, [slug, reloadKey])

  if (missing) return <PortalNotFound slug={slug ?? ''} />

  if (loadError) {
    return (
      <Shell brand="#0f172a">
        <Panel className="p-6 text-center space-y-3">
          <LifeBuoy className="mx-auto h-8 w-8 text-amber-500" />
          <h1 className="text-base font-black text-slate-900 dark:text-white">
            Portal unavailable
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">{loadError}</p>
          <button
            onClick={() => setReloadKey((k) => k + 1)}
            className="mt-2 inline-flex items-center gap-2 rounded-xl bg-slate-700 px-4 py-2.5 text-xs font-bold text-white"
          >
            <RefreshCw className="h-4 w-4" /> Try again
          </button>
        </Panel>
      </Shell>
    )
  }

  if (!state) {
    return (
      <Shell brand="#0f172a">
        <div className="flex justify-center py-16 text-slate-400">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      </Shell>
    )
  }

  return <Storefront slug={slug!} {...state} />
}

/**
 * The portal itself: header, packages, and the ways in.
 *
 * Section order is deliberate and mobile-first. Packages come before anything
 * else because they are what the customer came for; the secondary ways in
 * (voucher, existing login, reconnect) follow underneath rather than competing
 * with the catalogue for the top of the screen.
 */
function Storefront({ slug, settings, packages }: { slug: string } & PortalState) {
  const brand = settings.primary_color || settings.brand_color || '#2563eb'
  const currency = settings.currency_label || 'KES'
  // Accent is used for the secondary, less important affordances (voucher,
  // reconnect) so the buy button stays the single obvious action on the page.
  const accent = settings.accent_color || brand

  const [buying, setBuying] = useState<PortalPackage | null>(null)
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [payment, setPayment] = useState<{ reference: string; message: string } | null>(null)
  const [payError, setPayError] = useState<string | null>(null)

  const [code, setCode] = useState('')
  const [codePhone, setCodePhone] = useState('')
  const [voucher, setVoucher] = useState<Outcome>(null)
  const [voucherBusy, setVoucherBusy] = useState(false)

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [login, setLogin] = useState<Outcome>(null)
  const [loginBusy, setLoginBusy] = useState(false)

  const [reconnect, setReconnect] = useState<Outcome>(null)
  const [reconnectBusy, setReconnectBusy] = useState(false)

  const mac = useMemo(() => macFromLocation(), [])
  const wa = whatsappHref(settings.support_whatsapp)

  async function submitPurchase(e: FormEvent) {
    e.preventDefault()
    if (!buying) return
    setBusy(true)
    setPayError(null)
    try {
      // Only these three values leave the browser. The price and the payment
      // destination are the server's to decide.
      const res = await startPortalPayment({ slug, planId: buying.id, phone })
      setPayment({ reference: res.reference, message: res.message })
      setBuying(null)
    } catch (err) {
      setPayError(err instanceof PortalError ? err.message : 'Could not start the payment.')
    } finally {
      setBusy(false)
    }
  }

  async function submitVoucher(e: FormEvent) {
    e.preventDefault()
    setVoucherBusy(true)
    setVoucher(null)
    try {
      const res = await redeemPortalVoucher(slug, code, codePhone)
      setVoucher({ ok: res.success, message: res.message })
      if (res.success) setCode('')
    } catch (err) {
      setVoucher({
        ok: false,
        message: err instanceof PortalError ? err.message : 'Could not redeem that code.',
      })
    } finally {
      setVoucherBusy(false)
    }
  }

  async function submitLogin(e: FormEvent) {
    e.preventDefault()
    setLoginBusy(true)
    setLogin(null)
    try {
      const res = await loginPortalCustomer(slug, username, password)
      setLogin(res)
      if (res.ok) setPassword('')
    } catch (err) {
      setLogin({
        ok: false,
        message: err instanceof PortalError ? err.message : 'Could not sign you in.',
      })
    } finally {
      setLoginBusy(false)
    }
  }

  async function submitReconnect(e: FormEvent) {
    e.preventDefault()
    setReconnectBusy(true)
    setReconnect(null)
    try {
      setReconnect(await reconnectPortalCustomer(slug, username))
    } catch (err) {
      setReconnect({
        ok: false,
        message: err instanceof PortalError ? err.message : 'Could not reconnect you.',
      })
    } finally {
      setReconnectBusy(false)
    }
  }

// The tenant's own background. An image takes precedence over the flat colour,
// and a radial wash of the brand colour is layered under whichever is set, so an
// ISP that configures neither still gets a branded page rather than a blank one.
  return (
    <div
      className="min-h-screen pb-24"
      style={{
        backgroundColor: settings.background_color || undefined,
        backgroundImage: settings.background_url
          ? `linear-gradient(rgba(15,23,42,.55), rgba(15,23,42,.55)), url(${settings.background_url})`
          : `radial-gradient(120% 80% at 50% 0%, ${brand}22, transparent 70%)`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundAttachment: 'fixed',
      }}
    >
      <PortalHeader settings={settings} brand={brand} wa={wa} />
      {/* No negative margin here. The header's height depends on the logo, the
          wrapping contact details and the "Already paid?" link, so any fixed
          pull-up either collided with the packages heading or left a gap. The
          overlap that matters is the first PANEL riding up over the header,
          which is done on the panel itself below. */}
      <div className="relative z-10 mx-auto w-full max-w-3xl space-y-5 px-4 pt-5">
        {settings.welcome_message && (
          <Panel className="p-4">
            <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
              {settings.welcome_message}
            </p>
          </Panel>
        )}

        {/* â”€â”€ Packages: the reason this page exists â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            Hidden entirely when the ISP turns it off, rather than shown empty:
            a storefront with no products should not advertise a product shelf. */}
        {settings.show_packages && (
        <section aria-labelledby="packages-heading">
          <h2
            id="packages-heading"
            className="mb-3 text-center text-sm font-black tracking-wide text-slate-800 dark:text-white"
          >
            {settings.packages_heading}
          </h2>

          {packages.length === 0 ? (
            <Panel>
              <p className="p-6 text-center text-xs text-slate-500 dark:text-slate-400">
                No packages are available right now. Please contact us for help.
              </p>
            </Panel>
          ) : (
            // One column on the narrowest phones, two from 360px, three when there is
            // room: a two-up grid at 320px leaves each card too narrow to read a price.
            <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 md:grid-cols-3">
              {packages.map((pkg) => (
                <PackageCard
                  key={pkg.id}
                  pkg={pkg}
                  brand={brand}
                  currency={currency}
                  badge={settings.popular_label}
                  buttonText={settings.connect_button_text}
                  onBuy={() => {
                    setBuying(pkg)
                    setPayError(null)
                    setPayment(null)
                    setPhone('')
                  }}
                />
              ))}
            </div>
          )}
        </section>
        )}

        {settings.show_packages && settings.payment_instructions && (
            <p className="mt-3 rounded-xl bg-white/80 px-4 py-3 text-[11px] leading-relaxed text-slate-500 dark:bg-slate-900/80 dark:text-slate-400">
              {settings.payment_instructions}
            </p>
          )}

        {/* â”€â”€ Waiting for M-Pesa â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        {payment && <PaymentWaiting slug={slug} currency={currency} {...payment} />}

        {/* â”€â”€ Voucher: an additional option, not the whole portal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        {settings.show_voucher && settings.login_method !== 'customer' && (
          <section aria-labelledby="voucher-heading">
            <Panel>
              <SectionTitle id="voucher-heading" icon={<Ticket className="h-4 w-4" />}>
                Have a voucher code?
              </SectionTitle>
              <form onSubmit={submitVoucher} className="space-y-3 p-4 pt-0">
                <Input
                  label="Voucher code"
                  value={code}
                  onChange={setCode}
                  placeholder="XXXX-0000"
                  mono
                  autoComplete="off"
                />
                <Input
                  label="Phone number"
                  value={codePhone}
                  onChange={setCodePhone}
                  placeholder="07XXXXXXXX"
                  inputMode="tel"
                />
                <BigButton brand={accent} loading={voucherBusy} type="submit">
                  Activate voucher
                </BigButton>
                <OutcomeNote outcome={voucher} />
              </form>
            </Panel>
          </section>
        )}

{/* â”€â”€ Existing active package â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        {settings.show_login && settings.login_method !== 'voucher' && (
          <section aria-labelledby="login-heading">
            <Panel>
              <SectionTitle id="login-heading" icon={<User className="h-4 w-4" />}>
                Already have an active package?
              </SectionTitle>
              <form onSubmit={submitLogin} className="space-y-3 p-4 pt-0">
                <Input label="Username" value={username} onChange={setUsername} autoComplete="username" />
                <Input
                  label="Password"
                  type="password"
                  value={password}
                  onChange={setPassword}
                  autoComplete="current-password"
                />
                <BigButton brand={accent} loading={loginBusy} type="submit">
                  Connect
                </BigButton>
                <OutcomeNote outcome={login} />
              </form>
            </Panel>
          </section>
        )}

        {/* â”€â”€ Reconnect â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        {settings.show_reconnect && (
          <section aria-labelledby="reconnect-heading">
            <Panel>
              <SectionTitle id="reconnect-heading" icon={<RefreshCw className="h-4 w-4" />}>
                Reconnect
              </SectionTitle>
              <form onSubmit={submitReconnect} className="space-y-3 p-4 pt-0">
                <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                  Lost your connection but already paid? Enter your username and we will release
                  any session your router left hanging.
                </p>
                <Input
                  label="Username"
                  value={username}
                  onChange={setUsername}
                  placeholder={mac ?? 'Your username'}
                  autoComplete="username"
                />
                <BigButton
                  brand={brand}
                  loading={reconnectBusy}
                  type="submit"
                  variant="secondary"
                >
                  Force reconnection / Troubleshoot
                </BigButton>
                <OutcomeNote outcome={reconnect} />
              </form>
            </Panel>
          </section>
        )}

        {settings.show_mac && mac && (
          <p className="text-center text-[11px] text-slate-500 dark:text-slate-400">
            Your MAC address: <span className="font-mono">{mac}</span>
          </p>
        )}

        <PortalFooter settings={settings} brand={brand} />
      </div>

      {settings.show_contact && wa && (
        <a
          href={wa}
          target="_blank"
          rel="noreferrer noopener"
          aria-label="Contact support on WhatsApp"
          className="fixed bottom-5 right-5 z-20 grid h-14 w-14 place-items-center rounded-full text-white shadow-xl"
          style={{ backgroundColor: brand }}
        >
          <Phone className="h-6 w-6" />
        </a>
      )}

      {buying && (
        <BuySheet
          pkg={buying}
          brand={brand}
          currency={currency}
          phone={phone}
          setPhone={setPhone}
          busy={busy}
          error={payError}
          onSubmit={submitPurchase}
          onClose={() => setBuying(null)}
        />
      )}
    </div>
  )
}

/** Branded header. Every value here comes from this tenant's settings. */
function PortalHeader({
  settings, brand, wa,
}: { settings: PortalSettings; brand: string; wa: string | null }) {
  // Only offer the shortcut when there is a login section for it to reach. A
  // voucher-only tenant would otherwise show a link that goes nowhere.
  const showAlreadyPaid = Boolean(
    settings.already_paid_text && settings.show_login && settings.login_method !== 'voucher',
  )
  return (
    <header style={{ backgroundColor: brand }}>
      <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-3 px-4 pb-5 pt-5">
        {settings.logo_url ? (
          <img
            src={settings.logo_url}
            alt=""
            className="h-12 w-12 shrink-0 rounded-xl bg-white object-contain p-1"
          />
        ) : (
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-white/15 text-white">
            <Wifi className="h-6 w-6" />
          </span>
        )}

        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-black leading-tight text-white">
            {settings.isp_name}
          </h1>
          {settings.portal_name && (
            <p className="truncate text-[11px] text-white/70">{settings.portal_name}</p>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1 text-[11px] text-white/90">
          {settings.header_text && (
            <span className="max-w-[9rem] text-right">{settings.header_text}</span>
          )}
          {wa ? (
            <a href={wa} target="_blank" rel="noreferrer noopener" className="font-bold underline">
              {settings.support_phone ?? 'Contact us'}
            </a>
          ) : (
            settings.support_phone && <span className="font-bold">{settings.support_phone}</span>
          )}
        </div>
      {/* "Already paid?" is the single most-tapped control on a captive portal that
            has just taken someone's money: they have a receipt, not connectivity,
            and the first thing they want is to get online. It is a real link that
            jumps to the login form, not decoration - and it is only rendered when
            there is a login section to jump to. */}
        {showAlreadyPaid && (
          <a
            href="#login-heading"
            className="w-full rounded-xl bg-white/15 px-3 py-2 text-center text-[11px] font-bold text-white underline underline-offset-2 transition hover:bg-white/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
          >
            {settings.already_paid_text}
          </a>
        )}
      </div>
    </header>
  )
}

/**
 * One package.
 *
 * Two columns on a phone, three from `md` up. Very narrow phones fall back to
 * one column, because a price rendered at a size nobody can read is worse than a
 * card that is a little taller.
 */
function PackageCard({
  pkg, brand, currency, badge, buttonText, onBuy,
}: {
  pkg: PortalPackage
  brand: string
  currency: string
  badge: string
  buttonText: string
  onBuy: () => void
}) {
  const [open, setOpen] = useState(false)
  const details = [pkg.speed_down, pkg.data_limit].filter(Boolean).join(' • ')

  return (
    <article
      className={cn(
        'flex flex-col overflow-hidden rounded-2xl bg-white shadow-sm ring-1',
        pkg.is_featured ? 'ring-2 ring-amber-400' : 'ring-slate-200',
      )}
    >
      {pkg.is_featured && (
        <p className="bg-amber-400 py-1 text-center text-[10px] font-black tracking-wide text-amber-950">
          {badge}
        </p>
      )}

      <div className="flex flex-1 flex-col items-center px-3 py-4 text-center">
        <span
          className="max-w-full truncate rounded-full px-3 py-1 text-[10px] font-black tracking-wide text-white"
          style={{ backgroundColor: brand }}
        >
          {pkg.name}
        </span>

        <p className="mt-2 text-xl font-black text-slate-900">
          <span className="text-xs font-bold text-slate-500">{currency}</span>{' '}
          {Number(pkg.price).toLocaleString()}
        </p>

        {pkg.duration_label && (
          <p className="mt-0.5 text-[11px] text-slate-500">{pkg.duration_label}</p>
        )}
        {details && <p className="mt-0.5 text-[10px] text-slate-400">{details}</p>}
      </div>

      <div className="p-2.5 pt-0">
        <button
          onClick={onBuy}
          className="min-h-[44px] w-full rounded-xl px-3 py-2.5 text-xs font-bold text-white shadow-sm"
          style={{ backgroundColor: brand }}
        >
          {buttonText}
        </button>

        {pkg.description && (
          <>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="mt-1.5 flex w-full items-center justify-center gap-1 text-[10px] font-bold text-slate-500"
            >
              Details
              <ChevronDown className={cn('h-3 w-3 transition', open && 'rotate-180')} />
            </button>
            {open && (
              <p className="mt-1 text-[10px] leading-relaxed text-slate-500">{pkg.description}</p>
            )}
          </>
        )}
      </div>
    </article>
  )
}

/**
 * The M-Pesa sheet.
 *
 * The amount shown is the one this portal rendered from the package it loaded.
 * It is shown to confirm, not to authorise: the server resolves the chargeable
 * amount again from the plan row, so editing this number cannot change what the
 * customer is billed.
 */
function BuySheet({
  pkg, brand, currency, phone, setPhone, busy, error, onSubmit, onClose,
}: {
  pkg: PortalPackage
  brand: string
  currency: string
  phone: string
  setPhone: (v: string) => void
  busy: boolean
  error: string | null
  onSubmit: (e: FormEvent) => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-30 flex items-end justify-center bg-slate-900/50 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Connect to ${pkg.name}`}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-t-3xl bg-white p-5 shadow-2xl dark:bg-slate-900 sm:rounded-3xl"
      >
        <p className="text-center text-base font-black text-slate-900 dark:text-white">{pkg.name}</p>
        <p className="mt-1 text-center text-xs text-slate-500 dark:text-slate-400">
          {currency} {Number(pkg.price).toLocaleString()}
          {pkg.duration_label ? ` • ${pkg.duration_label}` : ''}
        </p>

        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <Input
            label="M-Pesa phone number"
            value={phone}
            onChange={setPhone}
            placeholder="07XXXXXXXX"
            inputMode="tel"
            required
          />
          {error && <OutcomeNote outcome={{ ok: false, message: error }} />}
          <BigButton brand={brand} loading={busy} type="submit">
            Pay with M-Pesa
          </BigButton>
          <button type="button" onClick={onClose} className="w-full py-2 text-xs font-bold text-slate-500">
            Cancel
          </button>
        </form>
      </div>
    </div>
  )
}

/**
 * The waiting screen.
 *
 * Polls the server's view of the payment. It deliberately reports what the
 * platform has actually recorded: "pending" until a verified provider result
 * settles it. Nothing here activates anything, and nothing here claims the
 * customer is online before the backend says so.
 */
function PaymentWaiting({
  slug, currency, reference, message,
}: { slug: string; currency: string; reference: string; message: string }) {
  const [status, setStatus] = useState<string>('pending')
  const [note, setNote] = useState(message)
  const [amount, setAmount] = useState<number | null>(null)
  const stopped = useRef(false)

  const check = useCallback(async () => {
    if (stopped.current) return
    try {
      const res = await fetchPortalPaymentStatus(slug, reference)
      if (res.found && res.status) {
        setStatus(res.status)
        if (res.message) setNote(res.message)
        if (res.amount != null) setAmount(Number(res.amount))
        if (res.status !== 'pending') {
          stopped.current = true
          return
        }
      }
    } catch {
      // A transient failure keeps polling; the payment itself is unaffected.
    }
    if (!stopped.current) window.setTimeout(() => void check(), 4000)
  }, [slug, reference])

  useEffect(() => {
    const timer = window.setTimeout(() => void check(), 2500)
    return () => { stopped.current = true; window.clearTimeout(timer) }
  }, [check])

  const settled = status === 'success'
  const failed = status === 'failed' || status === 'reversed'

  return (
    <Panel className="p-5 text-center">
      {settled ? (
        <>
          <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-500" />
          <p className="mt-2 text-sm font-black text-slate-900 dark:text-white">Payment received</p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{note}</p>
          {amount != null && (
            <p className="mt-1 text-[11px] text-slate-400">
              {currency} {amount.toLocaleString()}
            </p>
          )}
          <p className="mt-3 text-[11px] text-slate-500 dark:text-slate-400">
            You can close this page and your device will connect.
          </p>
        </>
      ) : (
        <>
          <Loader2
            className={cn('mx-auto h-6 w-6 animate-spin', failed ? 'text-rose-500' : 'text-slate-400')}
          />
          <p className="mt-2 text-sm font-black text-slate-900 dark:text-white">
            {failed ? 'Payment not completed' : 'Waiting for your confirmation'}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{note}</p>
          <p className="mt-3 font-mono text-[10px] text-slate-400">Ref {reference}</p>
          {!failed && (
            <p className="mt-1 text-[10px] text-slate-400">
              Enter your M-Pesa PIN on your phone to complete this payment.
            </p>
          )}
        </>
      )}
    </Panel>
  )
}

/** Contact, quick links, social and the footer. Only configured links appear. */
function PortalFooter({ settings, brand }: { settings: PortalSettings; brand: string }) {
  const wa = whatsappHref(settings.support_whatsapp)
  const social = Object.entries(settings.social_links ?? {}).filter(([, v]) => !!v)
  const quick = Object.entries(settings.quick_links ?? {}).filter(([, v]) => !!v)
  const year = new Date().getFullYear()

  return (
    <footer style={{ backgroundColor: brand }} className="rounded-2xl px-4 py-6 text-white">
      {settings.show_contact && (wa || settings.support_phone || settings.support_email) && (
        <section aria-labelledby="contact-heading">
          <h3 id="contact-heading" className="text-[11px] font-black uppercase tracking-wide">
            Contact us
          </h3>
          <ul className="mt-2 space-y-1 text-[11px] text-white/90">
            {wa && (
              <li>
                <a href={wa} target="_blank" rel="noreferrer noopener">
                  WhatsApp: {settings.support_whatsapp}
                </a>
              </li>
            )}
            {settings.support_phone && <li>Phone: {settings.support_phone}</li>}
            {settings.support_email && (
              <li>
                <a href={`mailto:${settings.support_email}`}>{settings.support_email}</a>
              </li>
            )}
          </ul>
        </section>
      )}

      {settings.show_quick_links && quick.length > 0 && (
        <section aria-labelledby="quick-heading" className="mt-5">
          <h3 id="quick-heading" className="text-[11px] font-black uppercase tracking-wide">
            Quick links
          </h3>
          <ul className="mt-2 space-y-1 text-[11px] text-white/90">
            {quick.map(([key, href]) => (
              <li key={key}>
                <a href={href} target="_blank" rel="noreferrer noopener">
                  {QUICK_LINK_LABELS[key] ?? key}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {settings.show_social && social.length > 0 && (
        <section aria-labelledby="social-heading" className="mt-5">
          <h3 id="social-heading" className="text-[11px] font-black uppercase tracking-wide">
            Follow us
          </h3>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-white/90">
            {social.map(([key, href]) => (
              <li key={key}>
                <a href={href} target="_blank" rel="noreferrer noopener">
                  {SOCIAL_LABELS[key.toLowerCase()] ?? key}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="mt-6 text-[10px] text-white/70">
        © {year} {settings.footer_text || settings.isp_name}. All rights reserved.
      </p>
      {settings.hide_routeros && (
        <p className="mt-1 flex items-center justify-center gap-1 text-[10px] text-white/50">
          <ShieldCheck className="h-3 w-3" /> Secured by {config.appName}
        </p>
      )}
    </footer>
  )
}

// â”€â”€ Small shared pieces â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function Shell({ brand, children }: { brand: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10 dark:bg-slate-950">
      <div className="relative mx-auto w-full max-w-md">
        <div
          className="absolute inset-x-0 -top-10 h-40 opacity-[0.08]"
          style={{ background: `radial-gradient(circle at 50% 0%, ${brand}, transparent 70%)` }}
        />
        <div className="relative">{children}</div>
      </div>
    </div>
  )
}

function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('rounded-2xl bg-white shadow-sm ring-1 ring-slate-200', className)}>
      {children}
    </div>
  )
}

function SectionTitle({
  id, icon, children,
}: { id: string; icon: ReactNode; children: ReactNode }) {
  return (
    <h2
      id={id}
      className="flex items-center justify-center gap-2 px-4 pb-3 pt-5 text-center text-sm font-black text-slate-900 dark:text-white"
    >
      <span className="text-slate-400">{icon}</span>
      {children}
    </h2>
  )
}

function Input({
  label, value, onChange, placeholder, type = 'text', mono, required, inputMode, autoComplete,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  mono?: boolean
  required?: boolean
  inputMode?: 'text' | 'tel' | 'numeric'
  autoComplete?: string
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-bold text-slate-600 dark:text-slate-300">
        {label}
      </span>
      <input
        type={type}
        value={value}
        required={required}
        inputMode={inputMode}
        autoComplete={autoComplete}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm text-slate-900',
          'placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-300',
          'dark:border-slate-700 dark:bg-slate-800 dark:text-white',
          mono && 'text-center font-mono uppercase tracking-widest',
        )}
      />
    </label>
  )
}

/** Large enough to hit on a phone, which is how captive portals are used. */
function BigButton({
  brand, children, loading, type = 'button', variant = 'primary',
}: {
  brand: string
  children: ReactNode
  loading?: boolean
  type?: 'button' | 'submit'
  variant?: 'primary' | 'secondary'
}) {
  return (
    <button
      type={type}
      disabled={loading}
      className={cn(
        'flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl px-4 py-3',
        'text-sm font-bold transition disabled:opacity-60',
        variant === 'primary'
          ? 'text-white shadow-sm'
          : 'border border-slate-300 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200',
      )}
      style={variant === 'primary' ? { backgroundColor: brand } : undefined}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  )
}

function OutcomeNote({ outcome }: { outcome: Outcome }) {
  if (!outcome) return null
  return (
    <p
      role="status"
      className={cn(
        'rounded-xl px-3 py-2.5 text-[11px] font-medium leading-relaxed',
        outcome.ok
          ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300'
          : 'bg-rose-50 text-rose-800 dark:bg-rose-500/10 dark:text-rose-300',
      )}
    >
      {outcome.message}
    </p>
  )
}

function PortalNotFound({ slug }: { slug: string }) {
  return (
    <Shell brand="#0f172a">
      <Panel className="p-6 text-center">
        <p className="text-5xl font-black text-slate-200 dark:text-slate-700">404</p>
        <h1 className="mt-2 text-base font-black text-slate-900 dark:text-white">Portal not found</h1>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          No ISP is registered at <span className="font-mono">/portal/{slug}</span>.
        </p>
        <Link to="/" className="mt-4 inline-block text-xs font-bold text-slate-500 underline">
          Back to the platform
        </Link>
      </Panel>
    </Shell>
  )
}

// â”€â”€ Demo mode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// The local store only, so `npm run dev` without a backend still shows a real
// storefront rather than a blank page. These never run against a live project:
// the loader returns on the live branch before reaching them.

function demoSettings(isp: Isp): PortalSettings {
  return {
    is_enabled: true,
    portal_name: isp.name,
    welcome_message: 'Choose a package below and pay with M-Pesa to get online.',
    terms_conditions: null,
    support_email: isp.contact_email,
    support_phone: isp.contact_phone,
    support_whatsapp: isp.contact_phone,
    logo_url: null,
    background_url: null,
    background_color: null,
    primary_color: isp.brand_color,
    accent_color: null,
    login_method: 'both',
    show_packages: true,
    payment_instructions: null,
    footer_text: null,
    social_links: {},
    hide_routeros: true,
    isp_name: isp.name,
    isp_slug: isp.slug,
    brand_color: isp.brand_color,
    contact_email: isp.contact_email,
    contact_phone: isp.contact_phone,
    header_text: 'Already paid? Tap to reconnect.',
    connect_button_text: 'Click Here To Connect',
    already_paid_text: 'Already Paid? Click Here.',
    packages_heading: 'AVAILABLE INTERNET PACKAGES',
    popular_label: 'MOST POPULAR',
    currency_label: 'KES',
    featured_plan_id: null,
    show_voucher: true,
    show_login: true,
    show_reconnect: true,
    show_contact: true,
    show_social: true,
    show_quick_links: true,
    show_mac: true,
    quick_links: {},
  }
}

function demoPackages(plans: Plan[], ispId: string): PortalPackage[] {
  return plans
    .filter((p) => p.isp_id === ispId && p.kind === 'hotspot' && p.is_active)
    .sort((a, b) => Number(a.price) - Number(b.price))
    .map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      duration_label: p.duration_label,
      duration_hours: p.duration_hours,
      price: Number(p.price),
      speed_down: p.speed_down,
      speed_up: p.speed_up,
      data_limit: p.data_limit,
      fup: p.fup ?? null,
      description: p.description ?? null,
      is_popular: p.is_popular,
      is_featured: p.is_popular,
    }))
}

