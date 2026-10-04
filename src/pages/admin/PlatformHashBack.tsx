/**
 * Legacy HashBack configuration — super admin only.
 *
 * WHY THIS STILL EXISTS
 * ---------------------
 * HashBack is no longer the active provider; PayHero is. But historical payments
 * were settled through it, and an operator reconciling one needs to see what was
 * configured at the time. The screen is therefore kept, reachable, and clearly
 * marked legacy — it is NOT the place to configure new collections, and it says so
 * at the top rather than relying on the reader noticing the URL.
 *
 * Nothing was removed. The credential store, the verification call and the
 * settlement path all still work, because a historical callback can still arrive
 * and has to settle correctly.
 *
 * It remains the one screen in the product where a payment credential is entered.
 * Two rules shape everything here:
 *
 *   1. A stored secret is never sent back to the browser, so the fields cannot show
 *      a masked value pretending to be editable. They are write-only: blank means
 *      "leave unchanged", and the saved state is shown as a boolean.
 *   2. Nothing says Connected unless HashBack actually said so. "Configured" and
 *      "Verified" are separate states, because a key can be stored and still be
 *      wrong — and a platform owner who cannot tell those apart will enable
 *      payments that silently fail.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  ShieldCheck, KeyRound, Plug, RefreshCw, CircleAlert, CheckCircle2,
  Landmark, Link2, TriangleAlert,
} from 'lucide-react'
import {
  fetchPlatformHashBackStatus,
  savePlatformHashBackCredentials,
  verifyPlatformHashBack,
  PaymentError,
  type PlatformHashBackStatus,
  type PlatformVerificationResult,
} from '../../lib/payments'
import { config } from '../../lib/config'
import {
  Alert, Badge, Button, Card, CardHeader, Field, Spinner, inputClass,
} from '../../components/ui'

/** Maps the stored connection state to a tone. Never invents a good state. */
const STATUS_TONE: Record<string, string> = {
  unconfigured: 'slate',
  configured: 'amber',
  verified: 'emerald',
  failed: 'rose',
}

const STATUS_LABEL: Record<string, string> = {
  unconfigured: 'NOT CONFIGURED',
  configured: 'CONFIGURED — NOT YET VERIFIED',
  verified: 'VERIFIED',
  failed: 'VERIFICATION FAILED',
}

function ago(iso: string | null): string {
  if (!iso) return 'never'
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

/** One capability row. Absent data reads as unknown, never as a green tick. */
function Capability({
  icon, label, state, detail,
}: {
  icon: React.ReactNode
  label: string
  /** null means "not determined", which is not the same as "no". */
  state: boolean | null
  detail?: string | null
}) {
  const tone = state === null ? 'slate' : state ? 'emerald' : 'rose'
  const text = state === null ? 'NOT CHECKED' : state ? 'AVAILABLE' : 'UNAVAILABLE'
  return (
    <div className="flex items-start gap-3 rounded-lg border border-slate-800 p-3">
      <div className="mt-0.5 shrink-0 text-slate-500">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-slate-200">{label}</span>
          <Badge value={text} className={tone} />
        </div>
        {detail && <p className="mt-1 text-xs text-slate-500">{detail}</p>}
      </div>
    </div>
  )
}

export default function PlatformHashBack() {
  const [status, setStatus] = useState<PlatformHashBackStatus | null>(null)
  const [verification, setVerification] = useState<PlatformVerificationResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Write-only fields. Deliberately never initialised from the server: there is
  // nothing safe to initialise them with.
  const [apiKey, setApiKey] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')
  const [webhookUrl, setWebhookUrl] = useState('')

  const load = useCallback(async () => {
    try {
      const s = await fetchPlatformHashBackStatus()
      setStatus(s)
      // The URL is not a secret, so it is safe to prefill for editing.
      if (s?.webhook_url) setWebhookUrl(s.webhook_url)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function save() {
    setSaving(true); setError(null); setNotice(null); setVerification(null)
    try {
      const next = await savePlatformHashBackCredentials({
        apiKey, webhookSecret, webhookUrl,
      })
      setStatus(next)
      // Clear the inputs immediately so the plaintext does not linger in the DOM.
      setApiKey('')
      setWebhookSecret('')
      setNotice('Credentials encrypted and stored. Verify the connection to activate them.')
    } catch (err) {
      setError(err instanceof PaymentError ? err.message : 'Could not save.')
    } finally {
      setSaving(false)
    }
  }

  async function verify() {
    setVerifying(true); setError(null); setNotice(null)
    try {
      const result = await verifyPlatformHashBack()
      setVerification(result)
      await load()
      if (result.apiAvailable) {
        setNotice('HashBack answered. API access confirmed.')
      } else {
        setError(result.lastError ?? 'HashBack did not answer.')
      }
    } catch (err) {
      setError(err instanceof PaymentError ? err.message : 'Verification failed.')
    } finally {
      setVerifying(false)
    }
  }

  if (loading) return <Spinner label="Reading HashBack connection state..." />

  if (config.mode !== 'live') {
    return (
      <Alert kind="info">
        Demo mode: no payment provider is contacted and no credential can be stored.
      </Alert>
    )
  }

  const webhookEndpoint = webhookUrl
    || `${config.supabaseUrl}/functions/v1/hashback-webhook`

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-black tracking-tight text-slate-900 dark:text-white">
          HashBack <span className="text-sm text-slate-400">(legacy)</span>
        </h1>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          The former M-Pesa collection account, kept so historical payments can be
          reconciled. PayHero is the active provider.
        </p>
      </div>

      {/* Stated on the screen, not only in the URL, so nobody configures new
          collections here by mistake. */}
      <Alert kind="warning">
        HashBack is <strong>no longer the active payment provider</strong>. New
        collections go through PayHero, which is configured under Platform &rarr;
        Payment gateway &rarr; PayHero. Keep this screen available only for
        reconciling payments that were already settled through HashBack.
      </Alert>

      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}

      <Card>
        <CardHeader
          title="Credentials"
          icon={<KeyRound className="h-4 w-4" />}
          subtitle="Encrypted before they are written. Never displayed again, and never sent to this page."
        />
        <div className="space-y-4 p-5">
          <Field
            label="HashBack API key"
            hint={status?.has_api_key
              ? 'A key is stored. Leave blank to keep it.'
              : 'Required. From Settings in the HashBack dashboard.'}
          >
            <input
              type="password"
              className={`${inputClass} font-mono text-[11px]`}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={status?.has_api_key ? '•••••••• (stored)' : 'Paste the API key'}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <Field
            label="Webhook secret"
            hint={status?.has_webhook_secret
              ? 'A secret is stored. Leave blank to keep it.'
              : 'From Dashboard → Webhooks in HashBack. Used to verify callbacks.'}
          >
            <input
              type="password"
              className={`${inputClass} font-mono text-[11px]`}
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
              placeholder={status?.has_webhook_secret ? '•••••••• (stored)' : 'Paste the webhook secret'}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <Field
            label="Webhook URL"
            hint="Register this in HashBack. A global webhook covers every channel linked later."
          >
            <input
              className={`${inputClass} font-mono text-[11px]`}
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder={webhookEndpoint}
            />
          </Field>

          <div className="flex flex-wrap gap-2">
            <Button loading={saving} icon={<ShieldCheck className="h-3.5 w-3.5" />} onClick={() => void save()}>
              {saving ? 'Storing...' : 'Store credentials'}
            </Button>
            <Button
              variant="secondary"
              loading={verifying}
              icon={<Plug className="h-3.5 w-3.5" />}
              onClick={() => void verify()}
            >
              {verifying ? 'Contacting HashBack...' : 'Connect & verify HashBack'}
            </Button>
            <Button variant="ghost" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => void load()}>
              Refresh
            </Button>
          </div>

          <p className="text-xs text-slate-500">
            Verify performs real calls: the token balance and, if the key allows it,
            the partner channel list. It does not create, change or delete anything.
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Connection status"
          icon={<CheckCircle2 className="h-4 w-4" />}
          action={status && (
            <Badge
              value={STATUS_LABEL[status.connection_status] ?? status.connection_status.toUpperCase()}
              className={STATUS_TONE[status.connection_status] ?? 'slate'}
            />
          )}
        />
        <div className="grid gap-3 p-5 sm:grid-cols-2">
          <Capability
            icon={<KeyRound className="h-4 w-4" />}
            label="API key stored"
            state={status?.has_api_key ?? null}
            detail="Encrypted at rest with AES-GCM."
          />
          <Capability
            icon={<ShieldCheck className="h-4 w-4" />}
            label="Webhook secret stored"
            state={status?.has_webhook_secret ?? null}
            detail="Required before any callback can be verified."
          />
          <Capability
            icon={<Plug className="h-4 w-4" />}
            label="API access"
            state={verification ? verification.apiAvailable : null}
            detail={verification?.lastError}
          />
          <Capability
            icon={<Link2 className="h-4 w-4" />}
            label="Partner access"
            state={verification ? verification.partnerAccess : null}
            detail={verification?.detail
              ?? 'Required for automatic channel provisioning.'}
          />
          <Capability
            icon={<Landmark className="h-4 w-4" />}
            label="Linked channels"
            state={verification ? verification.linkedChannels !== null : null}
            detail={verification?.linkedChannels != null
              ? `${verification.linkedChannels} channel(s) reported by HashBack.`
              : 'Reported by the partner API.'}
          />
          <Capability
            icon={<CircleAlert className="h-4 w-4" />}
            label="Service token balance"
            state={verification
              ? (verification.tokenBalance !== null && verification.tokenBalance > 0)
              : null}
            detail={verification?.tokenBalance != null
              ? `${verification.tokenBalance} tokens. Linking a channel costs 10; each STK prompt costs 1.`
              : 'Reported by HashBack. Free to read.'}
          />
        </div>

        <div className="px-5 pb-5 text-xs text-slate-500">
          Last verified: <span className="font-mono">{ago(status?.last_verified_at ?? null)}</span>
          {status?.last_error && (
            <div className="mt-1 text-rose-400">{status.last_error}</div>
          )}
        </div>
      </Card>

      {verification && !verification.partnerAccess && (
        <Alert kind="warning">
          <strong className="block">Partner API access unavailable.</strong>{' '}
          {verification.detail
            ?? 'This key cannot list or create payment channels, so ISPs must be given '
               + 'their HashBack Account ID by hand instead of having a channel '
               + 'provisioned automatically.'}
        </Alert>
      )}

      {verification?.apiAvailable && verification.tokenBalance !== null
        && verification.tokenBalance < 10 && (
        <Alert kind="warning">
          <TriangleAlert className="mr-1 inline h-3.5 w-3.5" />
          The service-token balance is below 10. Linking a new channel costs 10
          tokens and will be rejected, so new ISPs cannot be provisioned until the
          balance is topped up.
        </Alert>
      )}
    </div>
  )
}