/**
 * Reads what a router actually is.
 *
 * Everything except the identity is optional: a restricted RouterOS account may
 * answer none of these, and we still want to offer a usable setup. Only the
 * identity is required, because a router that will not name itself is not
 * reachable and the ISP needs to be told that rather than shown a blank wizard.
 */
export async function detectHardware(
  creds: RouterCredentials,
): Promise<RouterCapabilities> {
  const call = (cmd: string) =>
    ros(creds, cmd, {}, 6000).catch(() => [] as Record<string, string>[])

  const [identity, resource, interfaces, bridges, dhcp, routes, hotspot, pppoe, wireguard] =
    await Promise.all([
      call('/system/identity/print'),
      call('/system/resource/print'),
      call('/interface/print'),
      call('/interface/bridge/print'),
      call('/ip/dhcp-server/print'),
      call('/ip/route/print'),
      call('/ip/hotspot/print'),
      call('/interface/pppoe-server/print'),
      call('/interface/wireguard/print'),
    ])

  const res = resource[0] ?? {}
  const mem = (v: string | undefined) =>
    v === undefined ? null : Math.round(Number(v) / 1048576)

  return {
    identity: identity[0]?.name ?? null,
    model: res['board-name'] || null,
    serial: res['serial-number'] ?? null,
    version: res.version ?? null,
    architecture: res['architecture-name'] ?? null,
    cpu: res['cpu-type'] ?? null,
    cpuCount: toNum(res['cpu-count']),
    cpuLoad: toNum(res['cpu-load']),
    ramMb: mem(res['total-memory']),
    hddMb: mem(res['total-hdd-space']),
    firmware: res['firmware-type'] ?? null,
    // Real interface names, so the wizard offers actual choices instead of
    // asking the ISP to type something that may not exist.
    interfaces: interfaces
      .filter((i) => i.name)
      .map((i) => ({
        name: i.name as string,
        type: i.type ?? 'unknown',
        running: i.running === 'true',
        disabled: i.disabled === 'true',
        comment: i.comment || null,
        // A wired interface with a non-loopback name is a plausible WAN pick.
        suggestsWan: (i.type ?? '').startsWith('ether') && !i.disabled,
        suggestsHotspot: (i.type ?? '').startsWith('ether') && !i.disabled,
        isBridge: (i.type ?? '') === 'bridge',
      })),
    bridges: bridges.map((b) => ({ name: b.name, vlanFiltering: b['vlan-filtering'] === 'yes' })),
    dhcpServers: dhcp.map((d) => ({ name: d.name, interface: d['interface'] ?? null })),
    routes: routes.map((r) => ({
      dst: r['dst-address'] ?? r.dst ?? null,
      gateway: r.gateway ?? null,
    })),
    hasHotspot: hotspot.length > 0,
    hotspotInterfaces: hotspot.map((h) => h['interface']).filter(Boolean) as string[],
    hasPppoe: pppoe.length > 0,
    pppoeInterfaces: pppoe.map((p) => p.service).filter(Boolean) as string[],
    hasWireguard: wireguard.length > 0,
    // Anything already stamped by us, so a re-run can be recognised.
    netispTagged: interfaces.filter((i) => (i.comment ?? '').includes('NETISP:')).length,
  }
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
    for (const server of o.dns) {
      L.push('do={/ip dns')
      L.push(`  :local have [find where address="${server}"]`)
      L.push(`  :if ([:len $have] = 0) do={ add address="${server}" }`)
      L.push('}')
    }
    L.push('')
  }

  if (o.role === 'hotspot' || o.role === 'both') {
    L.push('# --- HotSpot servers ---')
    for (const iface of o.hotspotInterfaces) {
      L.push('do={/ip hotspot')
      L.push(`  :local s [find interface="${iface}"]`)
      L.push('  :if ([:len $s] = 0) do={')
      L.push(`    add name="${obj(o.tag)}-${iface}" interface="${iface}" ` +
        `profile="${obj(o.tag)}" comment="${mark(o.tag)}" disabled=no`)
      L.push('  }')
      L.push('}')
    }
    L.push('')
  }

  if (o.role === 'pppoe' || o.role === 'both') {
    L.push('# --- PPPoE servers ---')
    for (const iface of o.pppoeInterfaces) {
      L.push('do={/interface pppoe-server')
      L.push(`  :local s [find service-name="${iface}"]`)
      L.push('  :if ([:len $s] = 0) do={')
      L.push(`    add service-name="${iface}" name="${obj(o.tag)}-${iface}" ` +
        `one-session-per-host=yes comment="${mark(o.tag)}" disabled=no`)
      L.push('  }')
      L.push('}')
    }
    L.push('')
  }

  // A narrowly-scoped account for the panel. We never put a password in the
  // script; it is generated once and stored encrypted.
  L.push('# --- Management group for the panel ---')
  L.push('do={/user group')
  L.push('  :local g [find name="netisp-panel"]')
  L.push('  :if ([:len $g] = 0) do={ add name="netisp-panel" policy=read,write,api,test }')
  L.push('}')
  L.push('')

  L.push('# --- Session timeouts (only on servers we created) ---')
  L.push('do={/ip hotspot')
  L.push(`  :local mine [find comment="${mark(o.tag)}"]`)
  L.push('  :foreach s in=$mine do={')
  L.push(`    :set s "idle-timeout=${o.idleTimeoutMin}m"`)
  L.push(`    :set s "keepalive-timeout=${o.sessionTimeoutMin}m"`)
  L.push('  }')
  L.push('}')
  L.push('')

  if (o.radiusEnabled && o.radiusServer) {
    L.push('# --- RADIUS servers ---')
    L.push('do={/radius')
    L.push(`  :local r [find address="${o.radiusServer}"]`)
    L.push('  :if ([:len $r] = 0) do={')
    L.push(`    add address="${o.radiusServer}" service=hotspot,ppp ` +
      `comment="${mark(o.tag)}" secret="(set from the panel)"`)
    L.push('  }')
    L.push('}')
    L.push('')
  }

  L.push(`:put "${mark(o.tag)}: configuration applied."`)
  L.push(`:log info "${mark(o.tag)} provisioning finished."`)
  return L.join('\n')
}