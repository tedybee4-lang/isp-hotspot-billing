import { buildCompatibility, type CompatibilityProfile } from './compat.ts'
// =============================================================================
//  Capability detection for the Edge Function path.
//
//  The worker does the full survey (worker/src/handlers.ts) because it holds a
//  persistent socket and can afford to read more. This module is the
//  browser-driven equivalent: one shot, over WebSocket, for the wizard.
//
//  Every probe is independent. One command failing hides nothing, because the
//  result carries that probe's error alongside the ones that succeeded - which is
//  the difference between "this router has no wireless" and "we were not allowed
//  to ask".
// =============================================================================

import {
  probeMethods, runCommand, websocketChannel,
  type ChannelFactory, type ConnectionMethod, type RouterEndpoint,
} from './connection.ts'

export interface RouterCapabilities {
  identity: string | null
  model: string | null
  serial: string | null
  version: string | null
  architecture: string | null
  cpu: string | null
  cpuCount: number | null
  cpuLoad: number | null
  ramMb: number | null
  hddMb: number | null
  firmware: string | null
  /** CHR is software; it has no serial or temperature of its own. */
  isChr: boolean
  hardwareClass: string
  /** The transport the probe actually used, or 'unavailable'. */
  connectionMethod: string
  restAvailable: boolean
  apiAvailable: boolean
  apiSslAvailable: boolean
  sshAvailable: boolean
  unsupported: string[]
  /** Plain-language explanation, shown verbatim in the wizard. */
  managementNote: string
  interfaces: Array<{
    name: string
    type: string
    running: boolean
    disabled: boolean
    comment: string | null
    suggestsWan: boolean
    suggestsHotspot: boolean
    isBridge: boolean
    wireless: boolean
  }>
  bridges: Array<{ name: string; vlanFiltering: boolean }>
  wireless: Array<{ name: string; ssid: string | null }>
  dhcpServers: Array<{ name: string; interface: string | null }>
  routes: Array<{ dst: string | null; gateway: string | null }>
  services: Array<{ name: string; port: string | null }>
  hasHotspot: boolean
  hotspotInterfaces: string[]
  hasPppoe: boolean
  pppoeInterfaces: string[]
  hasWireguard: boolean
  /** Objects on this router that a previous NETISP run already created. */
  netispTagged: number
  /** Per-probe errors, so the wizard can explain itself. */
  probeErrors: Record<string, string | null>
}
export interface ProvisionOptions {
  tag: string
  role: 'hotspot' | 'pppoe' | 'both'
  hotspotInterfaces: string[]
  pppoeInterfaces: string[]
  wanInterface: string | null
  dns: string[]
  sessionTimeoutMin: number
  idleTimeoutMin: number
  radiusServer: string | null
  radiusEnabled: boolean
}

const mark = (t: string) => `NETISP:${t}`
const obj = (t: string) => `NETISP-${t}`

/**
 * Builds the RouterOS script for a router.
 *
 * Every block has the same shape: look for our object, create it only when it
 * is genuinely absent. Nothing is deleted, and nothing that predates us is
 * modified unless it already carries our tag. That is what makes the script
 * safe on a router someone has been running for years, and idempotent so a
 * half-finished provisioning can simply be run again.
 */
export function buildRouterScript(o: ProvisionOptions): string {
  const L: string[] = [
    `# NETISP provisioning - session ${o.tag}`,
    '# Safe to run repeatedly: every block checks before it acts.',
    `# Only objects tagged "${mark(o.tag)}" are created or updated.`,
    '# No factory reset, no firewall or WAN changes, no deletions.',
    '',
  ]

  if (o.dns.length) {
    L.push('# --- DNS resolvers ---')
    L.push(':global NETISP_DNS ' + o.dns.join(' '))
    o.dns.forEach((server, i) => {
      // A `:local` per server, not one reused name: reusing a name across blocks
      // is legal but makes the generated script harder to read when diagnosing.
      const v = `netispDns${i}`
      L.push(`:local ${v} [/ip/dns/find where address="${server}"]`)
      L.push(`:if ([:len $${v}] = 0) do={`)
      L.push(`    /ip/dns/add address="${server}"`)
      L.push('}')
    })
    L.push('')
  }

  if (o.role === 'hotspot' || o.role === 'both') {
    L.push('# --- HotSpot servers ---')
    o.hotspotInterfaces.forEach((iface, i) => {
      const v = `netispHs${i}`
      L.push(`:local ${v} [/ip/hotspot/find where interface="${iface}"]`)
      L.push(`:if ([:len $${v}] = 0) do={`)
      L.push(`    /ip/hotspot/add name="${obj(o.tag)}-${iface}" ` +
        `interface="${iface}" profile="${obj(o.tag)}" ` +
        `comment="${mark(o.tag)}" disabled=no`)
      L.push('}')
    })
    L.push('')
  }

  if (o.role === 'pppoe' || o.role === 'both') {
    L.push('# --- PPPoE servers ---')
    o.pppoeInterfaces.forEach((iface, i) => {
      const v = `netispPpp${i}`
      L.push(`:local ${v} [/interface/pppoe-server/find where service="${iface}"]`)
      L.push(`:if ([:len $${v}] = 0) do={`)
      L.push(`    /interface/pppoe-server/add service="${iface}" ` +
        `name="${obj(o.tag)}-${iface}" one-session-per-host=yes ` +
        `comment="${mark(o.tag)}" disabled=no`)
      L.push('}')
    })
    L.push('')
  }

  // A narrowly-scoped account for the panel. We never put a password in the
  // script; it is generated once and stored encrypted.
  L.push('# --- Management group for the panel ---')
  L.push(':local netispGrp [/user/group/find where name="netisp-panel"]')
  L.push(':if ([:len $netispGrp] = 0) do={')
  L.push('    /user/group/add name="netisp-panel" policy=read,write,api,test')
  L.push('}')
  L.push('')

  // Only emitted when HotSpot is actually in scope: a PPPoE-only router has no
  // /ip hotspot tree, so configuring it would be dead weight in its setup.
  if (o.role === 'hotspot' || o.role === 'both') {
    L.push('# --- Session timeouts (only on servers we created) ---')
    // A :foreach over OUR OWN tagged rows. That is the one place a bare
    // `do={ }` is legal, because it is an argument to :foreach rather than a
    // command with nothing to attach it to.
    L.push(`:local netispMine [/ip/hotspot/find where comment="${mark(o.tag)}"]`)
    L.push(':foreach netispSrv in=$netispMine do={')
    L.push(`    :set netispSrv "idle-timeout=${o.idleTimeoutMin}m"`)
    L.push(`    :set netispSrv "keepalive-timeout=${o.sessionTimeoutMin}m"`)
    L.push('}')
    L.push('')
  }

  if (o.radiusEnabled && o.radiusServer) {
    L.push('# --- RADIUS servers ---')
    L.push(`:local netispRad [/radius/find where address="${o.radiusServer}"]`)
    L.push(':if ([:len $netispRad] = 0) do={')
    // The secret is NOT embedded here. It is written by the worker during the
    // RADIUS stage, from the encrypted store, so it never travels in a script.
    L.push(`    /radius/add address="${o.radiusServer}:1812" ` +
      `comment="${mark(o.tag)}"`)
    L.push('}')
    L.push('')
  }

  L.push(`:put "${mark(o.tag)}: configuration applied."`)
  L.push(`:log info "${mark(o.tag)} provisioning finished."`)
  return L.join('\n')
}
// =============================================================================
//  Access provisioning: making the router reachable at all
//
//  The claim endpoint returns a RouterOS script, not JSON. That is the fix for
//  the flow that could never work: the old command did
//  `/tool fetch ... netisp-claim.rsc` followed by `/import file-name=`, and
//  `/import` only understands RouterOS commands. A JSON document can never be
//  imported, so the step always failed after the router had already called the
//  endpoint and consumed its token.
//
//  Everything below follows the same rule as buildRouterScript: additive,
//  idempotent, tagged, and never destructive.
// =============================================================================

/**
 * The single command the ISP pastes into the router terminal.
 *
 * A heredoc rather than a bare URL, so the token is not left in the router's
 * shell history, and so one file is both the claim and the configuration.
 */
export function buildProvisioningCommand(opts: {
  claimUrl: string
  token: string
}): string {
  return [
    '# ISPFlow provisioning - paste these lines into the router terminal.',
    '# Safe to run more than once. Nothing is deleted.',
    '{',
    `  :local u "${opts.claimUrl}";`,
    `  :local t "${opts.token}";`,
    '  :local f "ispflow-bootstrap.rsc";',
    // The router reports ITSELF, here, before fetching anything.
    //
    // Without these the callback URL carries `?token=` and nothing else, so
    // `buildCompatibility` is called with a null version. Every feature flag it
    // computes is then false, and a RouterOS 7.24.4 CHR was told it had no REST
    // and no WireGuard - because nobody ever asked it. Reading the values here,
    // on the device that owns them, is the fix; inventing a second version
    // detector on the server would only hide the same gap differently.
    '  :local v [/system/resource/get version];',
    '  :local b [/system/resource/get board-name];',
    '  :local a [/system/resource/get architecture-name];',
    '  :local n [/system/identity/get name];',
    // output=file is REQUIRED. `output=none` tells RouterOS to discard the
    // fetched bytes instead of writing dst-path, so the file check below could
    // never succeed and every router failed with "could not reach the
    // provisioning endpoint" no matter how healthy the link was.
    //
    // check-certificate=yes is required too, and was previously missing.
    // RouterOS does NOT validate TLS certificates by default (current manual,
    // /tool/fetch), so without it the single-use token travels over a
    // connection any proxy on the path can read and rewrite - and this fetch
    // returns a script the router then executes as root.
    //
    // keep-result is NOT set here, and that is deliberate and hardware-verified.
    // On a real RouterOS 7.24.4 CHR, combining it with output=file is rejected
    // outright:
    //
    //     failure: please use 'output' option
    //
    // The download still lands in dst-path; keep-result only controls whether the
    // RESULT is also held after the fetch, which this command has no use for. It
    // imports the file and then deletes it. The syntax confirmed working on that
    // exact device is: url=... mode=https check-certificate=yes output=file
    // dst-path=$f
    '  /tool fetch url=($u . "?token=" . $t . "&version=" . $v . "&board=" . $b . "&arch=" . $a . "&id=" . $n) mode=https check-certificate=yes output=file dst-path=$f;',
    '  :if ([:len [/file find name=$f]] = 0) do={',
    '    :error "ISPFlow: could not reach the provisioning endpoint.";',
    '  }',
    '  /import file-name=$f;',
    '  /file remove $f;',
    '}',
  ].join('\n')
}
/**
 * The tail of the configuration: the services and tunnel a router needs before
 * the worker can manage it.
 *
 * Version-gated, because issuing a command the firmware does not know aborts
 * the rest of the import. A RouterOS 6 box gets the API and nothing else; a
 * 7.1+ box additionally gets HTTPS REST and, when the platform supplies peer
 * details, a WireGuard tunnel.
 */
export function buildAccessScript(opts: {
  tag: string
  profile: CompatibilityProfile
  vpn?: {
    interfaceName: string
    listenPort: number
    peerPublicKey: string
    endpointHost: string
    endpointPort: number
    tunnelAddress: string
    allowedAddress: string
  } | null
}): string {
  const tag = opts.tag
  const L: string[] = [
    `# NETISP access - session NETISP:${tag}`,
    '# Enables management access. Additive and idempotent; deletes nothing.',
    '',
    '# --- RouterOS API on 8728. Present on every RouterOS including 6.x. ---',
    ':local ispFlowApi [/ip/service/find name="api"]',
    ':if ([:len $ispFlowApi] = 0) do={',
    '    /ip/service/add name="api" port=8728',
    '}',
    '',
    '# --- API over TLS on 8729. ---',
    ':local ispFlowApiSsl [/ip/service/find name="api-ssl"]',
    ':if ([:len $ispFlowApiSsl] = 0) do={',
    '    /ip/service/add name="api-ssl" port=8729',
    '}',
    '',
  ]

  // REST exists only from 7.1; sending it to a 6.x router aborts the import.
  //
  // THREE states, kept apart on purpose. "The version says no" and "we were never
  // told the version" are different facts, and only the first justifies telling an
  // operator their router lacks a feature. The second used to print "REST is not
  // available on this RouterOS version" on a RouterOS 7.24.4 CHR, which is simply
  // untrue.
  if (opts.profile.rest) {
    L.push('# --- HTTPS REST on 8080. RouterOS 7.1 and later only. ---')
    L.push(':local ispFlowRest [/ip/service/find name="www-ssl"]')
    L.push(':if ([:len $ispFlowRest] = 0) do={')
    L.push('    /ip/service/add name="www-ssl" port=8080')
    L.push('}')
    L.push('')
  } else if (opts.profile.versionKnown) {
    L.push('# This RouterOS version predates HTTPS REST. Management uses the RouterOS')
    L.push('# API above, which is why the platform never requires REST.')
    L.push('')
  } else {
    L.push('# HTTPS REST was not enabled: this router did not report its RouterOS')
    L.push('# version, and the platform does not send a 7.1+ command to a device it')
    L.push('# cannot identify. The RouterOS API above is sufficient for management.')
    L.push('')
  }

  const v = opts.vpn
  if (opts.profile.wireGuard && v) {
  L.push(`:local ispFlowWg [/interface/wireguard/find name="${v.interfaceName}"]`)
  L.push(':if ([:len $ispFlowWg] = 0) do={')
  L.push(`    /interface/wireguard/add name="${v.interfaceName}" ` +
    `listen-port=${v.listenPort} comment="NETISP:${tag}"`)
  L.push('}')
  L.push('')
  L.push(`:local ispFlowPeer [/interface/wireguard/peers/find ` +
    `where public-key="${v.peerPublicKey}"]`)
  L.push(':if ([:len $ispFlowPeer] = 0) do={')
  L.push(`    /interface/wireguard/peers/add interface="${v.interfaceName}" ` +
    `public-key="${v.peerPublicKey}" allowed-address="${v.allowedAddress}" ` +
    `endpoint-host="${v.endpointHost}" endpoint-port=${v.endpointPort} ` +
    `persistent-keepalive=25 comment="NETISP:${tag}"`)
  L.push('}')
  L.push('')
  L.push(`:local ispFlowWgAddr [/ip/address/find ` +
    `where interface="${v.interfaceName}"]`)
  L.push(':if ([:len $ispFlowWgAddr] = 0) do={')
  L.push(`    /ip/address/add address=${v.tunnelAddress} ` +
    `interface="${v.interfaceName}" comment="NETISP:${tag}"`)
  L.push('}')
  L.push('')
  } else if (!opts.profile.wireGuard && opts.profile.versionKnown) {
    L.push('# This RouterOS version has no WireGuard support. The router is managed')
    L.push('# over the API above, so it needs a reachable management address. Behind')
    L.push('# CGNAT that is not possible, and the panel says exactly that.')
    L.push('')
  } else if (!opts.profile.wireGuard) {
    // Unknown, not unsupported. Never announce a missing feature on a router
    // whose version was never reported.
    L.push('# No WireGuard tunnel was configured: this router did not report its')
    L.push('# RouterOS version. The platform manages it over the API above.')
    L.push('')
  }

  // Variables used here are DEFINED here, not assumed to exist.
  //
  // This script previously printed $identity, $version and $board-name, none of
  // which had ever been assigned anywhere in it. RouterOS does not provide them,
  // so the confirmation line rendered as "registered as  RouterOS  on " and
  // proved nothing at all. They are read from the router where they are used.
  L.push('# --- Report what this router is, from the router itself ---')
  L.push(':local ispFlowIdentity [/system/identity/get name]')
  L.push(':local ispFlowVersion [/system/resource/get version]')
  L.push(':local ispFlowBoard [/system/resource/get board-name]')
  // Assembled from parts so the emitted script is ONE logical line: a RouterOS
  // :put that wraps mid-expression is easy to mis-paste, and this is text an
  // operator runs blind.
  const SP = ' '
  L.push([
    ':put ("ISPFlow: this router is " . $ispFlowIdentity . ',
    `", RouterOS " . $ispFlowVersion . ${SP}`,
    '" on " . $ispFlowBoard . ".")',
  ].join(''))

  L.push(`:put "NETISP:${tag}: management access configured."`)
  return L.join('\n')
}

/**
 * Reads what a router actually is, over whichever transport works.
 *
 * The version decides what the firmware *could* do; the probes decide what it
 * *does*. A transport is reported available only when its service is confirmed
 * present and the firmware is new enough to have it, so an RB941-2nD never
 * shows a REST toggle that would fail.
 */
export async function detectHardware(
  endpoint: RouterEndpoint,
  factory: ChannelFactory = websocketChannel,
): Promise<RouterCapabilities> {
  const probe = await probeMethods(endpoint, factory)
  // If the probe found nothing, still try the API so the reported error comes
  // from a real connection attempt rather than a guess.
  const method: ConnectionMethod = probe.selected === 'unavailable' ? 'api' : probe.selected

  const [identity, resource, interfaces, bridges, wireless, dhcp, routes,
    hotspot, pppoe, wireguard, services] = await Promise.all([
      attempt(() => runCommand(endpoint, method, '/system/identity/print', {}, factory)),
      attempt(() => runCommand(endpoint, method, '/system/resource/print', {}, factory)),
      attempt(() => runCommand(endpoint, method, '/interface/print', {}, factory)),
      attempt(() => runCommand(endpoint, method, '/interface/bridge/print', {}, factory)),
      attempt(() => runCommand(endpoint, method, '/interface/wireless/print', {}, factory)),
      attempt(() => runCommand(endpoint, method, '/ip/dhcp-server/print', {}, factory)),
      attempt(() => runCommand(endpoint, method, '/ip/route/print', {}, factory)),
      attempt(() => runCommand(endpoint, method, '/ip/hotspot/print', {}, factory)),
      attempt(() => runCommand(endpoint, method, '/interface/pppoe-server/print', {}, factory)),
      attempt(() => runCommand(endpoint, method, '/interface/wireguard/print', {}, factory)),
      attempt(() => runCommand(endpoint, method, '/ip/service/print', {}, factory)),
    ])

  const res = resource.rows[0] ?? {}
  const mem = (v: string | undefined) =>
    (v === undefined ? null : Math.round(Number(v) / 1048576))
  const version = res.version ?? null
  const architecture = res['architecture-name'] ?? null
  const board = res['board-name'] ?? null

  const compat = buildCompatibility(version, architecture, board)
  const serviceNames = services.rows.map((s) => s.name ?? '')

  return {
    identity: identity.rows[0]?.name ?? board,
    model: board,
    serial: res['serial-number'] ?? null,
    version,
    architecture,
    cpu: res['cpu-type'] ?? null,
    cpuCount: toNum(res['cpu-count']),
    cpuLoad: toNum(res['cpu-load']),
    ramMb: mem(res['total-memory']),
    hddMb: mem(res['total-hdd-space']),
    firmware: res['firmware-type'] ?? null,
    isChr: compat.isChr,
    hardwareClass: compat.hardwareClass,
    connectionMethod: probe.selected,
    restAvailable: serviceNames.includes('www-ssl') && compat.rest,
    apiAvailable: serviceNames.includes('api'),
    apiSslAvailable: serviceNames.includes('api-ssl') && compat.apiSsl,
    sshAvailable: serviceNames.includes('ssh'),
    unsupported: compat.unsupported,
    managementNote: probe.selected === 'unavailable'
      ? 'No management transport answered. '
        + probe.methods.map((m) => `${m.method}: ${m.error}`).join('; ')
      : compat.managementNote,
    // Real interface names, so the wizard offers actual choices instead of
    // asking the ISP to type something that may not exist.
    interfaces: interfaces.rows
      .filter((i) => i.name)
      .map((i) => ({
        name: i.name as string,
        type: i.type ?? 'unknown',
        running: i.running === 'true',
        disabled: i.disabled === 'true',
        comment: i.comment || null,
        suggestsWan: (i.type ?? '').startsWith('ether') && !i.disabled,
        suggestsHotspot: (i.type ?? '').startsWith('ether') && !i.disabled,
        isBridge: (i.type ?? '') === 'bridge',
        wireless: wireless.rows.some((w) => w.name === i.name),
      })),
    bridges: bridges.rows.map((b) => ({
      name: b.name, vlanFiltering: b['vlan-filtering'] === 'yes',
    })),
    wireless: wireless.rows.map((w) => ({ name: w.name, ssid: w.ssid ?? null })),
    dhcpServers: dhcp.rows.map((d) => ({ name: d.name, interface: d['interface'] ?? null })),
    routes: routes.rows.map((r) => ({
      dst: r['dst-address'] ?? r.dst ?? null, gateway: r.gateway ?? null,
    })),
    services: services.rows.map((s) => ({ name: s.name, port: s.port ?? null })),
    hasHotspot: hotspot.rows.length > 0,
    hotspotInterfaces: hotspot.rows.map((h) => h['interface']).filter(Boolean) as string[],
    hasPppoe: pppoe.rows.length > 0,
    pppoeInterfaces: pppoe.rows.map((p) => p.service).filter(Boolean) as string[],
    hasWireguard: wireguard.rows.length > 0,
    // Anything already stamped by us, so a re-run can be recognised.
    netispTagged: interfaces.rows.filter((i) => (i.comment ?? '').includes('NETISP:')).length,
    probeErrors: {
      identity: identity.error, resource: resource.error,
      interfaces: interfaces.error, bridges: bridges.error, wireless: wireless.error,
      dhcp: dhcp.error, routes: routes.error, hotspot: hotspot.error,
      pppoe: pppoe.error, wireguard: wireguard.error, services: services.error,
    },
  }
}

/** Runs a command and keeps the error instead of throwing. */
async function attempt(
  run: () => Promise<{ rows: Record<string, string>[] }>,
): Promise<{ rows: Record<string, string>[]; error: string | null }> {
  try {
    return { ...(await run()), error: null }
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : String(err) }
  }
}

function toNum(value: string | undefined): number | null {
  if (value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
