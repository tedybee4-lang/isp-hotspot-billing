/**
 * Platform PayHero configuration — super admin only.
 *
 * This screen exists because PayHero requires a credential to be pasted once, and
 * it says so plainly rather than offering a "LOGIN / CONNECT PAYHERO" button that
 * could not work. PayHero publishes no OAuth, no Connect App and no delegated
 * authorization — its only documented scheme is a static Basic auth token — so
 * there is no PayHero page an operator could be redirected to in order to grant
 * access. A login button here would be a lie that fails silently at the worst
 * moment.
 *
 * Everything AFTER this one paste is automatic: saving verifies the credential
 * against the live API, discovers the account, balance and every registered Till
 * or PayBill, and lets each ISP's channel be assigned without anyone typing an
 * API key, a webhook secret or a callback URL again.
 *
 * Two rules shape the screen:
 *
 *   1. A stored secret is never sent back to the browser, so the field cannot show
 *      a masked value pretending to be editable. It is write-only: blank means
 *      "leave unchanged", and the saved state is shown as a boolean.
 *   2. Nothing says Connected unless PayHero actually said so. "Configured" and
 *      "Verified" are separate states, because a stored token can be wrong and a
 *      platform owner who cannot tell those apart will enable payments that
 *      silently fail.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  ShieldCheck, KeyRound, Plug, RefreshCw, CircleAlert, CheckCircle2,
  Wallet, Radio, Store,
} from 'lucide-react'
import {
  fetchPayHeroStatus,
  savePayHeroCredentials,
  verifyPayHeroConnection,
  refreshPayHeroChannels,
  disconnectPayHero,
  assignPayHeroChannel,
  fetchPayHeroIsps,
  PaymentError,
  type PayHeroPlatformStatus,
  type PayHeroVerificationResult,
  type PayHeroIspOption,
} from '../../lib/payhero'
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
  unconfigured: 'NOT CONNECTED',
  configured: 'CONFIGURED — NOT YET VERIFIED',
  verified: 'CONNECTED',
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
  const text = state === null ? 'NOT CHECKED' : state ? 'CONNECTED ✓' : 'UNAVAILABLE'
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
export default function PlatformPayHero() {
  const [status, setStatus] = useState<PayHeroPlatformStatus | null>(null)
  const [verification, setVerification] = useState<PayHeroVerificationResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Write-only field. Deliberately never initialised from the server: there is
  // nothing safe to initialise it with, because the stored value is never sent
  // here. This is the one manual step PayHero's API requires.
  const [apiToken, setApiToken] = useState('')
  const [selectedChannel, setSelectedChannel] = useState('')
  const [isps, setIsps] = useState<PayHeroIspOption[]>([])
  const [selectedIsp, setSelectedIsp] = useState('')

  const load = useCallback(async () => {
    try {
      const [s, tenants] = await Promise.all([
        fetchPayHeroStatus(),
        // A failure here must not blank the whole screen: the tenant list is an
        // aid to assignment, while the connection state is the page's purpose.
        fetchPayHeroIsps().catch(() => []),
      ])
      setStatus(s)
      setIsps(tenants)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function runVerify() {
    setVerifying(true); setError(null); setNotice(null)
    try {
      const result = await verifyPayHeroConnection()
      setVerification(result)
      setStatus(result.status)
      setNotice(
        result.channels.length > 0
          ? `PayHero connected. ${result.channels.length} payment channel(s) discovered.`
          : 'PayHero connected, but no payment channels are registered on the account.',
      )
    } catch (err) {
      setError((err as PaymentError).message)
    } finally {
      setVerifying(false)
    }
  }

  async function save() {
    setSaving(true); setError(null); setNotice(null); setVerification(null)
    try {
      await savePayHeroCredentials({ apiToken })
      // The token exists only in this closure. It is cleared immediately so it
      // cannot linger in component state, and it is never put back into the field.
      setApiToken('')
      setNotice('PayHero token saved. Verifying with PayHero…')
      // Saving is not the same as working, so verify immediately rather than
      // letting an operator assume a green tick they have not seen.
      await runVerify()
    } catch (err) {
      setError((err as PaymentError).message)
    } finally {
      setSaving(false)
    }
  }

  async function refresh() {
    setVerifying(true); setError(null); setNotice(null)
    try {
      const result = await refreshPayHeroChannels()
      setVerification(result)
      setStatus(result.status)
      setNotice('Channels refreshed from PayHero.')
    } catch (err) {
      setError((err as PaymentError).message)
    } finally {
      setVerifying(false)
    }
  }

  async function assign() {
    if (!selectedIsp || !selectedChannel) {
      setError('Choose an ISP and a payment channel first.')
      return
    }
    setError(null); setNotice(null)
    try {
      const next = await assignPayHeroChannel(selectedIsp, Number(selectedChannel))
      setStatus(next)
      setNotice('Payment channel assigned to that ISP.')
      setSelectedChannel('')
      // Reload so the tenant list reflects the new binding straight away.
      setIsps(await fetchPayHeroIsps().catch(() => isps))
    } catch (err) {
      setError((err as PaymentError).message)
    }
  }

  async function disconnect() {
    setDisconnecting(true); setError(null); setNotice(null)
    try {
      const next = await disconnectPayHero()
      setStatus(next)
      setVerification(null)
      setNotice('PayHero disconnected. The stored token was destroyed.')
    } catch (err) {
      setError((err as PaymentError).message)
    } finally {
      setDisconnecting(false)
    }
  }

  if (loading) return <Spinner />

  const connected = status?.connectionStatus === 'verified'
  const channels = verification?.channels ?? status?.channels ?? []

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-100">PayHero</h1>
        <p className="mt-1 text-sm text-slate-400">
          Connect your PayHero account to enable payments, STK and transaction
          verification across ISPFLOW.
        </p>
      </div>

      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      <Card>
        <CardHeader
          title="Connection"
          subtitle="How ISPFLOW authenticates to PayHero"
          icon={<Plug className="h-4 w-4" />}
        />
        <div className="space-y-4 p-5 pt-0">
          <Alert kind="info">
            PayHero does not support OAuth, Connect App or delegated account
            authorization, so there is no PayHero page ISPFLOW can send you to in
            order to grant access. Its official API authenticates with a static
            Basic token that you copy from your PayHero dashboard. Pasting it once
            below is the only manual step; verification, channel discovery and
            settlement are then automatic.
          </Alert>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="PayHero API token"
              hint="Write-only. Leave blank to keep the stored token. Never shown again after saving."
            >
              <input
                type="password"
                className={inputClass}
                value={apiToken}
                autoComplete="off"
                spellCheck={false}
                placeholder={status?.hasApiToken ? '•••••••• (stored)' : 'Paste your PayHero Basic token'}
                onChange={(e) => setApiToken(e.target.value)}
              />
            </Field>

            <div className="flex flex-col justify-end gap-2">
              <div className="flex items-center gap-2 text-sm">
                <ShieldCheck className="h-4 w-4 text-slate-500" />
                <span className="text-slate-300">Token stored</span>
                <Badge
                  value={status?.hasApiToken ? 'YES — ENCRYPTED' : 'NO'}
                  className={status?.hasApiToken ? 'emerald' : 'slate'}
                />
              </div>
              <Button onClick={save} disabled={saving || !apiToken.trim()}>
                {saving ? 'Saving…' : 'Save and verify'}
              </Button>
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Status"
          subtitle="Every value below was reported by PayHero itself"
          icon={<CheckCircle2 className="h-4 w-4" />}
        />
        <div className="space-y-4 p-5 pt-0">
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-400">Connection</span>
            <Badge
              value={STATUS_LABEL[status?.connectionStatus ?? 'unconfigured']}
              className={STATUS_TONE[status?.connectionStatus ?? 'unconfigured']}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Capability
              icon={<Store className="h-4 w-4" />}
              label="Account"
              state={status?.accountId != null}
              detail={
                status?.accountId != null
                  ? `PayHero account ···${String(status.accountId).slice(-3)}`
                  : 'Discovered when the connection is verified'
              }
            />
            <Capability
              icon={<Wallet className="h-4 w-4" />}
              label="Wallet balance"
              state={status?.balance != null}
              detail={
                status?.balance != null
                  ? `${status.currency ?? 'KES'} ${status.balance.toFixed(2)}`
                  : 'Reported by PayHero on verification'
              }
            />
            <Capability
              icon={<KeyRound className="h-4 w-4" />}
              label="STK push"
              // STK is available exactly when a channel exists, because an STK
              // prompt needs a destination Till.
              state={channels.length > 0 ? true : null}
              detail="POST /api/v2/payments — available once a channel is assigned"
            />
            <Capability
              icon={<ShieldCheck className="h-4 w-4" />}
              label="Transaction verification"
              state={connected}
              detail="GET /api/v2/transaction-status — every callback is confirmed with PayHero before anything is activated"
            />
          </div>

          <p className="text-xs text-slate-500">
            Last verified {ago(status?.lastVerifiedAt ?? null)}.
            {status?.lastError && ` Last error: ${status.lastError}`}
          </p>
        </div>
      </Card>
      <Card>
        <CardHeader
          title="Payment channels"
          subtitle="Tills and PayBills registered on the PayHero account"
          icon={<Radio className="h-4 w-4" />}
        />
        <div className="space-y-4 p-5 pt-0">
          {channels.length === 0 ? (
            <p className="text-sm text-slate-500">
              No channels discovered yet. Verify the connection, or refresh if the
              account has registered new Tills since the last check.
            </p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-slate-800">
              <table className="w-full text-sm">
                <thead className="bg-slate-900/60 text-left text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Channel</th>
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2">Short code</th>
                    <th className="px-3 py-2">Assigned</th>
                  </tr>
                </thead>
                <tbody>
                  {channels.map((c) => (
                    <tr key={c.id} className="border-t border-slate-800">
                      <td className="px-3 py-2 font-mono text-xs text-slate-300">{c.id}</td>
                      <td className="px-3 py-2 text-slate-300">{c.channelType}</td>
                      <td className="px-3 py-2 font-mono text-slate-300">
                        {c.shortCode || '—'}
                      </td>
                      <td className="px-3 py-2">
                        {c.assignedIspId ? (
                          <Badge value="IN USE" className="amber" />
                        ) : c.isActive ? (
                          <Badge value="AVAILABLE" className="emerald" />
                        ) : (
                          <Badge value="INACTIVE" className="slate" />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="PayHero channel"
              hint="Channel ids are identifiers, not credentials."
            >
              <select
                className={inputClass}
                value={selectedChannel}
                onChange={(e) => setSelectedChannel(e.target.value)}
              >
                <option value="">Choose a channel…</option>
                {channels
                  .filter((c) => c.isActive && !c.assignedIspId)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.channelType} · {c.shortCode || c.id} (id {c.id})
                    </option>
                  ))}
              </select>
            </Field>

            <Field
              label="ISP"
              hint="Each channel may be assigned to exactly one ISP. Switching an ISP to PayHero takes its payments off its current provider."
            >
              <select
                className={inputClass}
                value={selectedIsp}
                onChange={(e) => setSelectedIsp(e.target.value)}
              >
                <option value="">Choose an ISP…</option>
                {isps.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                    {i.currentProvider && i.currentProvider !== 'payhero'
                      ? ` — currently ${i.currentProvider}`
                      : ''}
                    {i.currentChannelId ? ` · channel ${i.currentChannelId}` : ''}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={refresh}
              disabled={verifying || !status?.hasApiToken}
            >
              <RefreshCw className="h-4 w-4" />
              {verifying ? 'Refreshing…' : 'Refresh channels'}
            </Button>
            <Button onClick={assign} disabled={!selectedChannel || !selectedIsp}>
              Assign channel
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Actions" icon={<CircleAlert className="h-4 w-4" />} />
        <div className="flex flex-wrap gap-2 p-5 pt-0">
          <Button
            variant="secondary"
            onClick={runVerify}
            disabled={verifying || !status?.hasApiToken}
          >
            Verify connection
          </Button>
          <Button
            variant="danger"
            onClick={disconnect}
            disabled={disconnecting || !status?.hasApiToken}
          >
            {disconnecting ? 'Disconnecting…' : 'Disconnect PayHero'}
          </Button>
        </div>
      </Card>
    </div>
  )
}