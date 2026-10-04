/**
 * Platform payments — the provider index.
 *
 * This page used to hold the shared Safaricom Daraja credentials (consumer key,
 * consumer secret and passkey) and the list of payment modes an ISP could pick.
 * None of that is here any more. Automated M-Pesa runs through PayHero, and the
 * platform credential lives on the PayHero screen, encrypted at rest and never
 * returned to the browser.
 *
 * WHY HASHBACK IS STILL LISTED
 * ----------------------------
 * Because it is real and still legible, but no longer active. There are historical
 * payments settled through it, and an operator reconciling one needs to reach the
 * old configuration screen. Presenting that as a legacy entry rather than deleting
 * it means nobody has to guess what a historical HashBack payment was, while
 * making it unambiguous which provider new money goes through.
 *
 * The route is kept so an existing bookmark or nav entry does not 404.
 */
import { Link } from 'react-router-dom'
import { CreditCard, Info, Archive } from 'lucide-react'
import { Card, CardHeader, Alert } from '../../components/ui'

export default function PlatformPayments() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">
          Platform Payments
        </h1>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
          PayHero is the active M-Pesa payment provider.
        </p>
      </div>

      <Card>
        <CardHeader
          title="PayHero"
          subtitle="Active provider — where the platform payment credential is configured"
          icon={<CreditCard className="w-4 h-4" />}
        />
        <div className="p-5 space-y-4">
          <Alert kind="info">
            <span className="flex items-start gap-2">
              <Info className="w-4 h-4 shrink-0 mt-px" />
              <span>
                Automated M-Pesa now runs through PayHero. Its Basic API token is
                encrypted at rest, never returned to this browser, and is only read by
                the Edge Functions that need it. Payment channels are discovered from
                PayHero and assigned to an ISP there.
              </span>
            </span>
          </Alert>

          <Link
            to="/admin/payment-gateway/payhero"
            className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-violet-700"
          >
            Open PayHero settings
          </Link>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="HashBack"
          subtitle="Legacy — historical payments only"
          icon={<Archive className="w-4 h-4" />}
        />
        <div className="p-5 space-y-4">
          <Alert kind="warning">
            <span className="flex items-start gap-2">
              <Info className="w-4 h-4 shrink-0 mt-px" />
              <span>
                HashBack is <strong>no longer the active provider</strong>. Existing
                payments settled through it are kept and still labelled HashBack, and
                this screen is retained so they can be reconciled. Do not configure new
                collections here.
              </span>
            </span>
          </Alert>

          <Link
            to="/admin/payment-gateway/hashback"
            className="inline-flex items-center gap-2 rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-bold text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            Open legacy HashBack settings
          </Link>
        </div>
      </Card>
    </div>
  )
}