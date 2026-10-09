export interface RouterSurvey {
  survey: string
  payload: unknown
  status?: string
}

export interface AutoHotspotPlan {
  wan: string
  lan: string
  address: string
  gateway: string
  network: string
  pool: string
  addNat: boolean
  addForward: boolean
  useRadius: boolean
  authenticationReady: boolean
}

export type AutoHotspotAssessment =
  | { ok: true; plan: AutoHotspotPlan }
  | { ok: false; reason: string }

type Row = Record<string, unknown>

function rows(surveys: Map<string, unknown>, name: string): Row[] {
  const value = surveys.get(name)
  return Array.isArray(value)
    ? value.filter((row): row is Row => !!row && typeof row === 'object' && !Array.isArray(row))
    : []
}

function enabled(row: Row): boolean {
  return !['true', 'yes', '1'].includes(String(row.disabled ?? '').toLowerCase())
}

function ip(value: unknown): string | null {
  const text = String(value ?? '').split('/')[0]
  const parts = text.split('.')
  if (parts.length !== 4 || parts.some((part) =>
    !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return null
  return text
}

function ipv4Number(value: string): number {
  return value.split('.').map(Number)
    .reduce((number, octet) => ((number * 256) + octet) >>> 0, 0)
}

function cidr(value: unknown): { address: string; prefix: number; network: string } | null {
  const text = String(value ?? '')
  const match = /^((?:\d{1,3}\.){3}\d{1,3})\/(\d{1,2})$/.exec(text)
  const address = ip(match?.[1])
  const prefix = Number(match?.[2])
  if (!address || !Number.isInteger(prefix) || prefix < 16 || prefix > 30) return null
  const number = ipv4Number(address)
  const mask = (0xffffffff << (32 - prefix)) >>> 0
  const net = (number & mask) >>> 0
  const network = [
    (net >>> 24) & 255, (net >>> 16) & 255, (net >>> 8) & 255, net & 255,
  ].join('.')
  return { address, prefix, network }
}

function poolFitsNetwork(
  ranges: unknown,
  network: { address: string; prefix: number; network: string },
): boolean {
  const rangeText = String(ranges ?? '').trim()
  if (!rangeText) return false
  const netStart = ipv4Number(network.network)
  const netEnd = netStart + (2 ** (32 - network.prefix)) - 1
  const gateway = ipv4Number(network.address)
  const pieces = rangeText.split(',').map((part) => part.trim())
  return pieces.every((piece) => {
    const match = /^((?:\d{1,3}\.){3}\d{1,3})-((?:\d{1,3}\.){3}\d{1,3})$/.exec(piece)
    const first = ip(match?.[1])
    const last = ip(match?.[2])
    if (!first || !last) return false
    const low = ipv4Number(first)
    const high = ipv4Number(last)
    return low <= high && low > netStart && high < netEnd
      && (gateway < low || gateway > high)
  })
}

function safeName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value)
}

export function assessAutoHotspot(surveys: RouterSurvey[]): AutoHotspotAssessment {
  const byName = new Map(surveys.map((survey) => [survey.survey, survey.payload]))
  const statusByName = new Map(surveys.map((survey) => [survey.survey, survey.status]))
  const required = [
    'dhcp-clients', 'routes', 'bridge', 'bridge_ports', 'ip_addresses',
    'dhcp', 'dhcp-networks', 'ip_pools', 'hotspot', 'hotspot-users', 'radius', 'nat',
    'interface-lists', 'interface-list-members', 'firewall', 'dns',
  ]
  if (required.some((name) => !byName.has(name))) {
    return { ok: false, reason: 'Router discovery is incomplete; waiting for all network surveys.' }
  }
  const unavailable = required.filter((name) => {
    const status = statusByName.get(name)
    return status !== undefined && status !== 'reported'
  })
  if (unavailable.length > 0) {
    return {
      ok: false,
      reason: `Required router surveys are unavailable: ${unavailable.join(', ')}.`,
    }
  }

  const defaultRoutes = rows(byName, 'routes').filter((row) =>
    row.dst_address === '0.0.0.0/0' && enabled(row)
    && ['true', 'yes'].includes(String(row.active ?? '').toLowerCase()))
  const boundClients = rows(byName, 'dhcp-clients').filter((row) =>
    enabled(row) && row.status === 'bound'
    && ['true', 'yes'].includes(String(row.add_default_route ?? '').toLowerCase())
    && safeName(row.interface) && ip(row.gateway))
  const wanRows = boundClients.filter((client) => defaultRoutes.some((route) =>
    String(route.gateway ?? '').split('%')[0] === String(client.gateway)))
  const wans = [...new Set(wanRows.map((row) => String(row.interface)))]
  if (wans.length !== 1) {
    return { ok: false, reason: 'Could not safely identify exactly one active DHCP WAN.' }
  }
  const wan = wans[0]

  const bridgeNames = new Set(rows(byName, 'bridge')
    .filter(enabled).map((row) => row.name).filter(safeName))
  const addressRows = rows(byName, 'ip_addresses').filter((row) =>
    enabled(row) && row.dynamic !== true && row.dynamic !== 'true'
    && bridgeNames.has(String(row.interface)) && cidr(row.address))
  const poolRows = rows(byName, 'ip_pools').filter(enabled)
  const pools = new Set(poolRows.map((row) => row.name).filter(safeName))
  const networkRows = rows(byName, 'dhcp-networks')
  const dnsRows = rows(byName, 'dns')
  const dhcpServers = rows(byName, 'dhcp').filter((row) =>
    enabled(row) && bridgeNames.has(String(row.interface))
    && safeName(row.interface) && safeName(row.address_pool)
    && pools.has(String(row.address_pool)))
  const lanCandidates = dhcpServers.flatMap((server) => {
    const lanAddresses = addressRows.filter((row) => row.interface === server.interface)
    if (lanAddresses.length !== 1) return []
    const address = lanAddresses[0]
    const lanAddress = cidr(address?.address)
    if (!lanAddress) return []
    const dhcpNetwork = networkRows.find((row) =>
      enabled(row) && row.address === `${lanAddress.network}/${lanAddress.prefix}`
      && row.gateway === lanAddress.address && String(row['dns-server'] ?? '').trim())
    if (!dhcpNetwork) return []
    const advertisedDns = String(dhcpNetwork['dns-server']).split(',').map((dns) => dns.trim())
    if (advertisedDns.some((dns) => !ip(dns))) return []
    const routerDns = advertisedDns.includes(lanAddress.address)
    const localResolverAvailable = dnsRows.some((row) =>
      enabled(row) && ['true', 'yes'].includes(String(row.allow_remote_requests).toLowerCase()))
    if (routerDns && !localResolverAvailable) return []
    return [{ server, lanAddress }]
  })
  const lans = [...new Set(lanCandidates.map((candidate) =>
    String(candidate.server.interface)))]
  if (lans.length !== 1 || lanCandidates.length !== 1) {
    return { ok: false, reason: 'Could not safely identify exactly one bridged, addressed HotSpot LAN with DHCP and DNS.' }
  }
  const lan = lans[0]
  const candidate = lanCandidates.find((entry) => entry.server.interface === lan)!
  if (lan === wan || rows(byName, 'bridge_ports').some((row) =>
    row.interface === wan && row.bridge === lan && enabled(row))) {
    return { ok: false, reason: 'The detected WAN overlaps the customer LAN bridge.' }
  }
  if (!safeName(candidate.server.address_pool)) {
    return { ok: false, reason: 'The LAN DHCP pool name is not safe for RouterOS provisioning.' }
  }
  const pool = poolRows.find((row) => row.name === candidate.server.address_pool)
  if (!poolFitsNetwork(pool?.ranges, candidate.lanAddress)) {
    return { ok: false, reason: 'The existing LAN DHCP pool is invalid or overlaps the network boundary/gateway.' }
  }
  if (rows(byName, 'hotspot').some((row) => row.interface === lan)) {
    return { ok: false, reason: 'A HotSpot server already exists on this LAN; automatic provisioning will not replace it.' }
  }

  const activeNat = rows(byName, 'nat').filter((row) =>
    enabled(row) && row.chain === 'srcnat' && row.action === 'masquerade')
  const wanLists = new Set(rows(byName, 'interface-list-members')
    .filter(enabled).filter((row) => row.interface === wan).map((row) => row.list))
  const hasNat = activeNat.some((row) =>
    !row['src-address'] && !row['dst-address']
    && !row['src-address-list'] && !row['dst-address-list']
    && (row['out-interface'] === wan
      || (typeof row['out-interface-list'] === 'string'
        && (row['out-interface-list'] === 'all' || wanLists.has(row['out-interface-list'])))))

  const forward = rows(byName, 'firewall').some((row) =>
    enabled(row) && row.chain === 'forward' && row.action === 'accept'
    && row['in-interface'] === lan && row['out-interface'] === wan
    && !row['src-address'] && !row['dst-address']
    && (!row['connection-state']
      || String(row['connection-state']).split(',').includes('new')))
  const radius = rows(byName, 'radius').some((row) => {
    const services = String(row.service ?? '').split(',').map((service) => service.trim())
    return enabled(row) && ip(row.address) && (services.includes('hotspot') || services.includes('all'))
  })
  const localUsers = rows(byName, 'hotspot-users').some((row) =>
    safeName(row.name) && enabled(row))
  const authReady = radius || localUsers
  const network = `${candidate.lanAddress.network}/${candidate.lanAddress.prefix}`

  return {
    ok: true,
    plan: {
      wan,
      lan,
      address: `${candidate.lanAddress.address}/${candidate.lanAddress.prefix}`,
      gateway: candidate.lanAddress.address,
      network,
      pool: String(candidate.server.address_pool),
      addNat: !hasNat,
      addForward: !forward,
      useRadius: radius,
      authenticationReady: authReady,
    },
  }
}

function ros(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/\$/g, '\\$').replace(/"/g, '\\"')}"`
}

export interface AutoHotspotScriptOptions {
  baseUrl: string
  heartbeatToken: string
  commandId: string
  tag: string
  plan: AutoHotspotPlan
  assetNames: string[]
}

export function buildAutoHotspotScript(o: AutoHotspotScriptOptions): string {
  const base = new URL(o.baseUrl)
  const address = cidr(o.plan.address)
  if (base.protocol !== 'https:' || base.search || base.hash
    || base.username || base.password || !base.pathname.endsWith('/router-provision')
    || !/^[0-9a-f]{64}$/i.test(o.heartbeatToken)
    || !/^[0-9a-f]{8}$/i.test(o.tag)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(o.commandId)
    || ![o.plan.wan, o.plan.lan, o.plan.pool].every(safeName)
    || !address || address.address !== o.plan.gateway
    || `${address.network}/${address.prefix}` !== o.plan.network
    || !o.assetNames.length
    || new Set(o.assetNames).size !== o.assetNames.length
    || o.assetNames.some((name) => !/^[a-z0-9.-]{1,64}$/i.test(name))) {
    throw new Error('Refusing to generate a router command from invalid plan data.')
  }
  const portal = `ispflow-${o.tag}-hotspot`
  const profile = `ISPFlow-${o.tag}`
  const server = `ISPFlow-${o.tag}`
  const ownerComment = ros(`ISPFlow:${o.tag}`)
  const natComment = ownerComment
  const forwardComment = ownerComment
  const profileParams = `hotspot-address=${ros(o.plan.gateway)} html-directory=${ros(portal)} ` +
    `login-by=http-chap use-radius=${o.plan.useRadius ? 'yes' : 'no'} comment=${ownerComment}`
  const commands = [
    `:do { /file add name=${ros(portal)} type=directory } on-error={};`,
    ...o.assetNames.map((name) =>
      `/tool fetch mode=https check-certificate=yes output=file url=${ros(
        `${o.baseUrl}/asset/${encodeURIComponent(name)}?token=${o.heartbeatToken}`,
      )} dst-path=${ros(`${portal}/${name}`)};`),
    `:local ispflowProfile [/ip hotspot profile find where name=${ros(profile)}];`,
    `:if ([:len $ispflowProfile] = 0) do={ /ip hotspot profile add name=${ros(profile)} ${profileParams}; } else={ :if ([/ip hotspot profile get $ispflowProfile comment] != ${ownerComment}) do={ :error "ISPFlow: refusing to overwrite an unowned profile."; }; /ip hotspot profile set $ispflowProfile ${profileParams}; };`,
    `:local ispflowServer [/ip hotspot find where name=${ros(server)}];`,
    `:if ([:len $ispflowServer] = 0) do={ /ip hotspot add name=${ros(server)} interface=${ros(o.plan.lan)} address-pool=${ros(o.plan.pool)} profile=${ros(profile)} disabled=no comment=${ownerComment}; } else={ :if ([/ip hotspot get $ispflowServer comment] != ${ownerComment}) do={ :error "ISPFlow: refusing to overwrite an unowned HotSpot server."; }; :if ([/ip hotspot get $ispflowServer interface] != ${ros(o.plan.lan)}) do={ :error "ISPFlow: existing HotSpot server interface changed."; }; };`,
  ]
  commands.push(...o.assetNames.map((name) =>
    `:if ([:len [/file find where name=${ros(`${portal}/${name}`)}]] = 0) do={ :error "ISPFlow: a captive portal file is missing."; };`))
  if (o.plan.addNat) {
    commands.push(
      `:local ispflowNat [/ip firewall nat find where comment=${natComment} and chain=srcnat and action=masquerade and out-interface=${ros(o.plan.wan)}];`,
      `:if ([:len $ispflowNat] = 0) do={ /ip firewall nat add chain=srcnat action=masquerade out-interface=${ros(o.plan.wan)} comment=${natComment}; };`,
    )
  }
  if (o.plan.addForward) {
    commands.push(
      `:local ispflowForward [/ip firewall filter find where comment=${forwardComment} and chain=forward and action=accept and in-interface=${ros(o.plan.lan)} and out-interface=${ros(o.plan.wan)}];`,
      `:if ([:len $ispflowForward] = 0) do={ /ip firewall filter add chain=forward action=accept in-interface=${ros(o.plan.lan)} out-interface=${ros(o.plan.wan)} connection-state=new,established,related comment=${forwardComment} place-before=0; };`,
    )
  }
  commands.push(
    `:local ispflowVerifyProfile [/ip hotspot profile find where name=${ros(profile)}];`,
    `:local ispflowVerifyServer [/ip hotspot find where name=${ros(server)} and interface=${ros(o.plan.lan)} and disabled=no];`,
    ':if ([:len $ispflowVerifyProfile] = 0 || [:len $ispflowVerifyServer] = 0) do={ :error "ISPFlow: HotSpot verification failed."; };',
  )
  const ackUrl = `${o.baseUrl}/command-result?token=${o.heartbeatToken}`
  const ack = (state: 'complete' | 'failed') =>
    `/tool fetch mode=https check-certificate=yes http-method=post http-header-field="Content-Type:application/json" output=none url=${ros(ackUrl)} http-data=${ros(
      JSON.stringify({
        command_id: o.commandId,
        status: state,
        authentication_ready: state === 'complete' && o.plan.authenticationReady,
      }),
    )};`
  return [
    '# ISPFlow-ROUTER-COMMAND-GENERATOR-20C64B',
    '# ISPFlow authenticated router-initiated HotSpot setup',
    ':do {',
    ...commands.map((command) => `  ${command}`),
    `  ${ack('complete')}`,
    `} on-error={ :put "ISPFlow: automatic HotSpot setup failed; it will be retried."; ${ack('failed')} };`,
    o.plan.authenticationReady
      ? ':put "ISPFlow: HotSpot portal and detected authentication backend configured.";'
      : ':put "ISPFlow: portal installed, but no customer authentication backend was detected; customer access is not ready."; ',
  ].join('\n')
}

export function commandNoop(message = ''): string {
  return message ? `:put ${ros(`ISPFlow: ${message}`)};\n` : '# ISPFlow: no pending router command\n'
}

export interface RouterPullJob {
  id: string
  isp_id: string
  kind: string
  payload: Record<string, unknown>
}

function printable(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function ownedUserGuard(userVar: string, tag: string): string {
  return `:local ispflowComment [/ip hotspot user get $${userVar} comment]; ` +
    `:if ([:pick $ispflowComment 0 15] != ${tag}) do={ ` +
    ':error "ISPFlow: refusing to change an unowned subscriber."; };'
}

export function buildRouterPullJobScript(o: {
  baseUrl: string
  heartbeatToken: string
  job: RouterPullJob
}): string {
  const { job } = o
  const base = new URL(o.baseUrl)
  if (base.protocol !== 'https:' || base.search || base.hash
    || base.username || base.password || !base.pathname.endsWith('/router-provision')
    || !/^[0-9a-f]{64}$/i.test(o.heartbeatToken)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(job.id)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(job.isp_id)) {
    throw new Error('Refusing to generate a router job from invalid identity data.')
  }

  const payload = job.payload
  const rawUserName = job.kind === 'voucher_sync' || job.kind === 'voucher_revoke'
    ? payload.code
    : payload.username
  // `printable` is a *type predicate*, so it returns a boolean and never the
  // value. Calling it in an expression (`const userName = printable(x, 64)`)
  // would bind `true` to the name and push the literal string "true" into the
  // RouterOS script, so validate first and use the narrowed original.
  if (!printable(rawUserName, 64)) {
    throw new Error('Router job is missing a safe HotSpot username.')
  }
  const userName = rawUserName
  const user = ros(userName)
  const tag = ros(`NETISP:${job.isp_id.slice(0, 8)}`)
  const ownsUser = ownedUserGuard('ispflowUser', tag)
  let operation: string
  let retryable = true

  if (job.kind === 'voucher_sync') {
    const password = payload.password === undefined ? userName : payload.password
    const profile = payload.profile === undefined ? 'default' : payload.profile
    if (!printable(password, 128) || !safeName(profile)) {
      throw new Error('Voucher job contains an invalid password or profile.')
    }
    const limit = payload.limit_uptime
    if (limit !== undefined && limit !== null
      && (typeof limit !== 'string' || !/^(?:\d+[wdhms])+$/.test(limit))) {
      throw new Error('Voucher job contains an invalid uptime limit.')
    }
    const limitArg = typeof limit === 'string' ? ` limit-uptime=${ros(limit)}` : ''
    operation = `:local ispflowUser [/ip hotspot user find where name=${user}]; ` +
      `:if ([:len $ispflowUser] = 0) do={ /ip hotspot user add name=${user} ` +
      `password=${ros(password)} profile=${ros(profile)} comment=${tag}${limitArg}; };`
  } else if (job.kind === 'voucher_revoke') {
    operation = `:local ispflowUser [/ip hotspot user find where name=${user}]; ` +
      `:if ([:len $ispflowUser] > 0) do={ ${ownsUser} ` +
      '/ip hotspot user remove $ispflowUser; };'
  } else if (job.kind === 'customer_sync') {
    const clientId = payload.client_id
    const password = payload.password
    const profile = payload.profile === undefined ? 'default' : payload.profile
    if (typeof clientId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientId)
      || !printable(password, 128) || !safeName(profile)) {
      throw new Error('Customer job is missing a safe account credential or profile.')
    }
    operation = `:local ispflowUser [/ip hotspot user find where name=${user}]; ` +
      `:if ([:len $ispflowUser] = 0) do={ /ip hotspot user add name=${user} ` +
      `password=${ros(password)} profile=${ros(profile)} comment=${tag} ` +
      `disabled=${payload.disabled === true ? 'yes' : 'no'}; } else={ ` +
      `${ownsUser} /ip hotspot user set $ispflowUser ` +
      `password=${ros(password)} profile=${ros(profile)} comment=${tag} ` +
      `disabled=${payload.disabled === true ? 'yes' : 'no'}; };`
  } else if (['customer_suspend', 'customer_expire', 'customer_reactivate'].includes(job.kind)) {
    const clientId = payload.client_id
    if (typeof clientId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientId)) {
      throw new Error('Customer status job has an invalid client identifier.')
    }
    operation = `:local ispflowUser [/ip hotspot user find where name=${user}]; `
    if (job.kind === 'customer_reactivate') {
      operation += ':if ([:len $ispflowUser] = 0) do={ :error "ISPFlow: subscriber account is missing."; }; '
      operation += `${ownsUser} /ip hotspot user set $ispflowUser disabled=no;`
      retryable = false
    } else {
      operation += `:if ([:len $ispflowUser] > 0) do={ ${ownsUser} ` +
        '/ip hotspot user set $ispflowUser disabled=yes; ' +
        `:foreach ispflowActive in=[/ip hotspot active find where user=${user}] do={ ` +
        '/ip hotspot active remove $ispflowActive; }; };'
    }
  } else {
    throw new Error(`Router job kind "${job.kind}" is not allowed over the pull channel.`)
  }

  const ackUrl = `${o.baseUrl}/job-result?token=${o.heartbeatToken}`
  const ack = (status: 'succeeded' | 'failed') =>
    `/tool fetch mode=https check-certificate=yes http-method=post ` +
    `http-header-field="Content-Type:application/json" output=none ` +
    `url=${ros(ackUrl)} http-data=${ros(JSON.stringify({
      job_id: job.id,
      status,
      retryable: status === 'failed' && retryable,
      error: status === 'failed' ? 'RouterOS rejected the subscriber update.' : null,
    }))};`
  return [
    '# ISPFlow-ROUTER-COMMAND-GENERATOR-20C64B',
    `:do { ${operation} ${ack('succeeded')} } on-error={ ${ack('failed')} };`,
  ].join('\n')
}
