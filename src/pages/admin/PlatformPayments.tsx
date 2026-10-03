/**
 * Platform payments - now a pointer to HashBack.
 *
 * This page used to hold the shared Safaricom Daraja credentials (consumer key,
 * consumer secret and passkey) and the list of payment modes an ISP could pick,
 * including "Platform Daraja" and "Own Daraja account".
 *
 * Daraja is no longer a payment provider. Automated M-Pesa runs through HashBack
 * and the platform credential lives on Platform -> Payment gateway -> HashBack,
 * encrypted at rest and never returned to the browser.
 *
 * The route is kept so an existing bookmark or nav entry does not 404; it holds
 * no credentials and no state.
 */
import { Link } from 'react-router-dom'
import { CreditCard, Info } from 'lucide-react'
import { Card, CardHeader, Alert } from '../../components/ui'

export default function PlatformPayments() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">
          Platform Payments
        </h1>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
          HashBack is the only M-Pesa payment provider.
        </p>
      </div>

      <Card>
        <CardHeader
          title="HashBack"
          subtitle="Where the platform payment credential is configured"
          icon={<CreditCard className="w-4 h-4" />}
        />
        <div className="p-5 space-y-4">
          <Alert kind="info">
            <span className="flex items-start gap-2">
              <Info className="w-4 h-4 shrink-0 mt-px" />
              <span>
                The shared Safaricom Daraja credentials that used to be configured here
                were removed with the Daraja cutover. The HashBack API key and webhook
                secret live on the HashBack screen, encrypted at rest.
              </span>
            </span>
          </Alert>

          <Link
            to="/admin/payment-gateway/hashback"
            className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-violet-700"
          >
            Open HashBack settings
          </Link>
        </div>
      </Card>
    </div>
  )
}