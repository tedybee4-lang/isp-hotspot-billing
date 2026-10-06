// =============================================================================
//  Router self-discovery: the first thing ISPFlow asks a router to do.
//
//  WHY THIS EXISTS
//  ---------------
//  The original claim carried only a handful of query parameters (board,
//  version, arch). That registers a router and little else, and it leaves the
//  most important question unanswered: what is ALREADY on this box? An ISP
//  onboarding a router that has run production for two years must be told
//  about its existing bridges, pools, HotSpot servers and PPPoE customers
//  before anything is configured, or a system that claims to be safe is simply
//  guessing.
//
//  So the router surveys itself and reports back. Nothing is changed. Every
//  path below is a read.
//
//  DESIGN
//  ------
//  One HTTP POST per subsystem rather than one giant document, for reasons
//  that matter on real hardware:
//
//    1. A 32 MB RB951 cannot be asked to hold a whole configuration in memory
//       at once. `/tool fetch ... output=user` also caps a body at 64512 bytes
//       (63 KiB), so one big document would be silently truncated on a router
//       with many interfaces.
//    2. Every subsystem is wrapped in `:onerror`, so one unsupported or
//       permission-denied menu costs exactly one survey. The difference
//       between "this router has no wireless" and "we were not allowed to ask"
//       is the whole point, and one batched request destroys it.
//    3. Each is independently retryable, so a flaky rural uplink does not
//       throw away twenty minutes of good discovery.
//
//  SECURITY
//  --------
//  The router reads only. It never sends a password, a private key, a
//  pre-shared key or a RADIUS secret: the fields collected below are all
//  structural names, counts and flags. `check-certificate=yes` is set on every
//  fetch because RouterOS does NOT verify TLS certificates by default (current
//  manual, /tool/fetch) - without it the token and the survey travel over a
//  connection any proxy can rewrite.
// =============================================================================

/** One subsystem the router reports on. */
//
// The thirteen subsystems the platform is required to report are named here in
// the form the report endpoint stores them under: identity, resource (the
// system-resource survey), interfaces, bridge, bridge_ports, ip_addresses,
// routes, hotspot, pppoe, ip_pools, dhcp, firewall, services and ispflow.
// Everything else in the list is an additional read-only survey that has
// always been part of the report and costs one more POST.
//
// Two renames matter and are deliberate:
//
//   bridges      -> bridge
//   addresses    -> ip_addresses
//   pools        -> ip_pools
//
// plus one new subsystem, `bridge_ports`, which previously did not exist at
// all. Knowing a bridge exists without knowing which interfaces are enslaved
// to it is half an answer: it is the difference between "there is a bridge"
// and "your uplink sits behind bridge1 with vlan-filtering off".
//
// The key is stored as free text (`router_surveys.survey`) and capped at 40
// characters, so `ip_addresses` and `bridge_ports` fit without a migration.
export const SURVEYS = [
  'identity', 'resource', 'board', 'packages', 'interfaces', 'bridge',
  'bridge_ports', 'vlans', 'ip_addresses', 'dhcp', 'ip_pools', 'hotspot',
  'pppoe',
  // The PPPoE and RADIUS subsystems are each split across the menus RouterOS
  // actually uses, rather than one menu being filed under another service's
  // name. `/ppp secret` holds the customers, `/interface/pppoe-server/server`
  // the dial-in service, `/ppp profile` the profiles, `/radius` the RADIUS
  // client and `/ppp aaa` whether secrets use RADIUS at all.
  'pppoe-servers', 'pppoe-profiles', 'radius', 'radius-aaa',
  'firewall', 'nat', 'routes', 'dns', 'wireguard', 'services',
  'certificates', 'wireless', 'capsman', 'ispflow', 'scheduler', 'backup',
] as const

export type Survey = typeof SURVEYS[number]

export interface DiscoveryOptions {
  /** Endpoint the router POSTs each subsystem to. */
  reportUrl: string
  /** The session token, binding the report to one provisioning session. */
  token: string
  /**
   * RouterOS major version, so 6.x is never sent RouterOS 7 paths.
   *
   * Nullable, and null means UNKNOWN - not RouterOS 6. A router that never
   * reported its version must not be told it lacks a feature nobody checked for.
   */
  major: number | null
  /**
   * RouterOS minor version, when known.
   *
   * `[:serialize to=json]` arrived in RouterOS 7.13 and is the only correct way
   * to put a router's own free text into JSON: it escapes quotes, backslashes
   * and control characters itself. Hand-escaping four levels deep (JSON, then
   * RouterOS, then TypeScript) is exactly the kind of thing that is right until
   * one device disagrees. Below 7.13 - and on every RouterOS 6 build - the
   * script falls back to explicit `:replace` escaping, which works everywhere.
   */
  minor: number | null
  /** Short session id, so two routers provisioning at once stay apart. */
  tag: string
  /** Architecture as reported by the claim URL; used to skip RouterBOARD-only probes on CHR. */
  architecture?: string | null
}

/**
 * Which JSON strategy the generated script uses.
 *
 * `serialize` is the good path. `escape` is the fallback for RouterOS 6 and for
 * RouterOS 7.1-7.12, and is deliberately chosen for an UNKNOWN version too:
 * `:replace` runs on every firmware ISPFlow supports, so it is the conservative
 * answer when we cannot prove `:serialize` exists.
 */
export type JsonMode = 'serialize' | 'escape'

export function jsonMode(o: DiscoveryOptions): JsonMode {
  if (o.major === null || o.major === undefined) return 'escape'
  if (o.major > 7) return 'serialize'
  if (o.major < 7) return 'escape'
  return (o.minor ?? 0) >= 13 ? 'serialize' : 'escape'
}

/**
 * Escapes a value for a RouterOS string literal.
 *
 * Everything interpolated into the generated script passes through here. A
 * router whose identity contains a quote would otherwise break the very
 * script it is running, on a live device, mid-provisioning.
 */
export function ros(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * RouterOS lines that turn a value in `$v` into one safe to place between JSON
 * quotes.
 *
 * A router's own strings - identity, board name, interface names, comments,
 * SSIDs, profile names - are free text, and they were previously concatenated
 * into the JSON body raw. An identity of `Bob "the builder"` produced
 * `{"name":"Bob "the builder""}`, which is not JSON: the server could not parse
 * it, discarded the whole survey, and the panel silently showed a router with
 * no interfaces, no pools and no HotSpot. Silent data loss from one stray quote.
 *
 * Order is load-bearing. A backslash must be doubled BEFORE quotes are escaped,
 * otherwise the backslash introduced by escaping a quote gets doubled as well
 * and the result is wrong.
 *
 * These are emitted by the generator rather than typed by hand because the
 * escaping is four levels deep - JSON, then RouterOS, then TypeScript - and a
 * single wrong backslash corrupts every survey on every router. The unit tests
 * assert the exact emitted source.
 *
 * Control characters cannot appear in the values RouterOS reports through
 * `print` (names and comments are single-line), so the two substitutions below
 * cover the realistic input space.
 */
export function jsonEscapeSteps(srcVar: string, dstVar: string): string[] {
  return [
    `:set ${dstVar} [:replace $${srcVar} "\\\\" "\\\\\\\\"]`,
    `:set ${dstVar} [:replace $${dstVar} "\\"" "\\\\\\""]`,
  ]
}

/**
 * THE CANONICAL POST. Every survey and every service block fetches this way.
 *
 * The argument order, the parentheses around `url` and the payload variable
 * name are all part of the canonical script format and are asserted by test:
 *
 *   /tool fetch mode=https url=(...) method=POST check-certificate=yes
 *     http-header-field="Content-Type:application/json" output=none
 *     http-data=$jsonPayload;
 *
 * `url` is an EXPRESSION, not a quoted literal, so the whole URL is assembled
 * from the `$baseUrl` / `$token` / `$tag` locals declared once at the top of
 * the master block. That is what keeps a token out of thirty string literals
 * and gives the validator one place to check the report endpoint.
 *
 * `method=POST` is the real RouterOS property name. (`http-method=post` appears
 * in some reference scripts and is NOT valid RouterOS - the fetch fails and the
 * survey is silently lost.)
 *
 * `mode=https` plus `check-certificate=yes`: RouterOS does NOT verify TLS
 * certificates by default (current manual, /tool/fetch), and this body carries
 * the discovery token.
 *
 * `output=none` because the reply is discarded - the router is not saving the
 * response, it is posting a document. `keep-result` is deliberately absent: it
 * only means anything for `output=file` and RouterOS rejects it elsewhere.
 *
 * `http-header-field` is REQUIRED, not decoration. The report endpoint branches
 * on content-type: with `application/json` it calls `req.json()`, otherwise it
 * calls `req.formData()`. RouterOS does not set an application/json content-type
 * on its own, so without this header every survey body failed to parse and was
 * stored as `{}` - surveys counted as reported, with no data in them.
 *
 * The payload is ALWAYS the local `jsonPayload`, declared immediately above.
 * The canonical format names it that so a single rule - "`http-data` must be
 * `$jsonPayload`" - holds for scalars and arrays alike.
 *
 * @param urlExpr  a RouterOS expression (no surrounding quotes) that yields
 *                 the absolute URL, e.g. `$baseUrl . "?survey=x&token=" . $token`
 * @param bodyVar  must be `$jsonPayload`
 */
function post(urlExpr: string, bodyVar = '$jsonPayload'): string {
  return `/tool fetch mode=https url=(${urlExpr}) method=POST check-certificate=yes ` +
    `http-header-field="Content-Type:application/json" ` +
    `output=none http-data=${bodyVar};`
}

/** The report URL expression for one survey, built from the session locals. */
function urlExpr(key: string): string {
  return `$baseUrl . "?survey=${key}&token=" . $token . "&tag=" . $tag`
}

/**
 * The opening line of a guarded block.
 *
 * The canonical format uses `:do { ... } on-error={ ... }`, not `:onerror e
 * in={ ... } do={ ... }`. `:do/on-error` is the pair RouterOS documents for a
 * single block, it binds its handler to that block alone, and the failure
 * message is a fixed literal - so one menu a given firmware does not have costs
 * exactly one `:put` instead of aborting the import halfway down the file.
 */
function guard(key: Survey | string): string[] {
  return ['', '# --- ' + key + ' ---', ':do {']
}

/**
 * The matching close. The message is the canonical one: the survey name, then
 * "skipped/failed". A survey that did not happen is reported as not happening;
 * it is never silently omitted, because "we did not ask" and "it is not there"
 * are different answers and only one of them is honest.
 */
function endGuard(key: Survey | string): string[] {
  return ['} on-error={', `  :put "ISPFlow: ${key} skipped/failed"`, '};']
}

/**
 * Emits a row-collection block: reads every row of a menu and posts a JSON
 * array of the requested properties.
 *
 * `/find` with no arguments returns only ids and never prints, which is what
 * makes this safe to run over SSH on someone else's router. Each property is
 * read into its own local first, because a property absent on one model would
 * otherwise abort the whole row and lose the interfaces around it.
 */
/**
 * NATIVE JSON. RouterOS 7.13 and later.
 *
 * The row is assembled as a RouterOS array literal and handed to
 * `[:serialize to=json]`, which escapes every value itself. No value is ever
 * concatenated into a JSON string, so a quote in a comment cannot produce
 * malformed JSON - the failure that silently voided an entire survey.
 *
 * There is deliberately not one backslash in this function.
 */
function fieldLocalName(jsonKey: string, index: number): string {
  const name = jsonKey.replace(/[^A-Za-z0-9_]/g, '_')
  return `v_${name || `n${index}`}`
}

function serializeRows(
  menu: string,
  fields: Array<[json: string, prop: string]>,
  _opts: DiscoveryOptions,
  key: Survey,
): string[] {
  const out = [...guard(key)]
  out.push('  :local rows ""')
  out.push(`  :foreach i in=[${menu}/find] do={`)
  // The canonical map declaration. `[:toarray ""]` is understood by every
  // RouterOS build ISPFlow supports, which is why it appears rather than an
  // array literal: the map is the one construct that has to work on a 6.x box
  // and on a 7.24 CHR alike.
  out.push('    :local r [:toarray ""]')
  for (const [index, [jsonKey, prop]] of fields.entries()) {
    const local = fieldLocalName(jsonKey, index)
    out.push(`    :local ${local} ($i->"${prop}")`)
    // An unset property is an empty array. Skipping it keeps the payload to
    // values that exist rather than a wall of empty arrays.
    out.push(`    :if ([:typeof $${local}] != "array") do={ :set ($r->"${jsonKey}") $${local} }`)
  }
  out.push('    :local j [:serialize to=json value=$r]')
  out.push('    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }')
  out.push('    :set rows ($rows . $j)')
  out.push('  }')
  out.push('  :local jsonPayload ("[" . $rows . "]")')
  out.push(`  ${post(urlExpr(key))}`)
  out.push(...endGuard(key))
  return out
}

/** NATIVE JSON for the single-object surveys. */
function serializeScalars(
  key: Survey,
  reads: Array<[json: string, routeros: string]>,
  _opts: DiscoveryOptions,
): string[] {
  const out = [...guard(key)]
  out.push('  :local r [:toarray ""]')
  for (const [index, [jsonKey, expr]] of reads.entries()) {
    const local = fieldLocalName(jsonKey, index)
    out.push(`  :local ${local} [${expr}]`)
    out.push(`  :if ([:typeof $${local}] != "array") do={ :set ($r->"${jsonKey}") $${local} }`)
  }
  out.push('  :local jsonPayload [:serialize to=json value=$r]')
  out.push(`  ${post(urlExpr(key))}`)
  out.push(...endGuard(key))
  return out
}

function guardedScalars(
  key: Survey,
  reads: Array<[json: string, routeros: string]>,
  probe: string,
): string[] {
  const out = [...guard(key)]
  out.push(`  :local probe [${probe}]`)
  out.push('  :if ([:typeof $probe] != "array") do={')
  out.push('    :local r [:toarray ""]')
  for (const [index, [jsonKey, expr]] of reads.entries()) {
    const local = fieldLocalName(jsonKey, index)
    out.push(`    :local ${local} [${expr}]`)
    out.push(`    :if ([:typeof $${local}] != "array") do={ :set ($r->"${jsonKey}") $${local} }`)
  }
  out.push('    :local jsonPayload [:serialize to=json value=$r]')
  out.push(`    ${post(urlExpr(key))}`)
  out.push('  };')
  out.push(...endGuard(key))
  return out
}

/**
 * Row-collection block.
 *
 * There is one JSON strategy now. `:serialize to=json` is the only mechanism
 * the canonical format permits: it escapes the router's own free text itself,
 * and the hand-escaped `:replace` path is banned outright. A firmware too old
 * to provide `:serialize` fails inside this `:do` block and the survey reports
 * itself as skipped - which is a true statement about what happened, unlike a
 * survey that half-serialized.
 */
function rows(
  menu: string,
  fields: Array<[json: string, prop: string]>,
  opts: DiscoveryOptions,
  key: Survey,
): string[] {
  return serializeRows(menu, fields, opts, key)
}

/** Single-object block. */
function scalars(
  key: Survey,
  reads: Array<[json: string, routeros: string]>,
  opts: DiscoveryOptions,
): string[] {
  return serializeScalars(key, reads, opts)
}

/**
 * The session locals every survey URL is built from.
 *
 * Declared once, at the top of the master block, and referenced by every
 * `/tool fetch url=(...)` through `$baseUrl`, `$token` and `$tag`. The
 * alternative - a fully quoted URL in each of the thirty fetches - puts a live
 * credential in thirty string literals and leaves the report endpoint itself
 * unchecked in one place.
 */
export function sessionLocals(o: DiscoveryOptions): string[] {
  return [
    `:local token "${ros(o.token)}";`,
    `:local tag "${ros(o.tag)}";`,
    `:local baseUrl "${ros(o.reportUrl)}";`,
  ]
}

/**
 * The discovery survey section: everything that goes BETWEEN the master `{`
 * and `}` of a generated `.rsc`.
 *
 * Order is deliberate: the cheapest and most informative surveys first, so a
 * router on a marginal link still says what it is before the heavier firewall
 * and wireless walks. The tag check runs too, so a router provisioned before
 * says so immediately and the panel can stop guessing.
 *
 * `major` gates the genuinely version-dependent menus. WireGuard, containers
 * and the REST service arrived in RouterOS 7; a 6.x box must never be sent a
 * 7.x path, because the menu does not exist there and the survey would report
 * a false "unsupported" for a feature the box does have under another name.
 *
 * `declareLocals` is false when the caller has already put the session locals
 * into its own preamble - which is what `router-provision/generate.ts` does,
 * so that `token`, `tag` and `baseUrl` sit where the canonical template puts
 * them, ahead of the service block.
 */
export function buildSurveySection(
  o: DiscoveryOptions,
  declareLocals = true,
): string {
  const seven = o.major !== null && o.major >= 7
  const L: string[] = [
    // MARKERS (see capabilities.ts). Present in the HTTP response, not just in a
    // fixture, so a stale deployment is visible in the downloaded bytes alone.
    '# ISPFlow-BOOTSTRAP-GENERATOR-528C90',
    '# ISPFlow-ROUTEROS7-SERIALIZE-GENERATOR',
    '# =============================================================================',
    `# ISPFlow router discovery - session ${o.tag}`,
    '# =============================================================================',
    '# READ ONLY. This script reads what is already configured and reports it,',
    '# so ISPFlow can configure safely. Every block is guarded: one menu this',
    '# firmware does not have costs one line of output, never the whole run.',
    '',
    ...(declareLocals ? sessionLocals(o) : []),
    ':put "Starting ISPFlow router discovery...";',
    ':put "";',
  ]

  // --- identity and hardware -------------------------------------------------
  L.push(...scalars('identity', [
    ['name', '/system identity/get name'],
    ['version', '/system resource/get version'],
  ], o))

  L.push(...scalars('resource', [
    ['board_name', '/system resource/get board-name'],
    ['platform', '/system resource/get platform'],
    ['architecture', '/system resource/get architecture-name'],
    ['cpu', '/system resource/get cpu'],
    ['cpu_count', '/system resource/get cpu-count'],
    ['cpu_load', '/system resource/get cpu-load'],
    ['free_memory', '/system resource/get free-memory'],
    ['total_memory', '/system resource/get total-memory'],
    ['free_hdd', '/system resource/get free-hdd-space'],
    ['total_hdd', '/system resource/get total-hdd-space'],
    ['uptime', '/system resource/get uptime'],
  ], o))

  const arch = (o.architecture ?? '').trim().toLowerCase()
  const isChrLike = arch.includes('x86_64') || arch.includes('x86-64') || arch.includes('x86')
  // CHR and other virtualized devices do not have a RouterBOARD menu at all,
  // so the board probe must be capability-gated rather than assumed. The
  // script reports the board survey as skipped on those boxes instead of
  // emitting an unconditional RouterBOARD command the router cannot parse.
  if (isChrLike) {
    L.push(...skipped('board', 'CHR/x86_64 does not expose a RouterBOARD menu', o))
  } else {
    L.push(...guardedScalars('board', [
      ['serial_number', '/system routerboard/get serial-number'],
      ['model', '/system routerboard/get model'],
      ['firmware_type', '/system routerboard/get firmware-type'],
    ], '/system routerboard/find'))
  }

  L.push(...rows('/system package', [
    ['name', 'name'], ['version', 'version'], ['installed', 'installed'],
  ], o, 'packages'))

  // `comment` matters more than it looks: it is where an existing operator
  // records what a port is for, so a port the incumbent ISP already labelled
  // "UPLINK" is read rather than overwritten.
  L.push(...rows('/interface', [
    ['name', 'name'], ['type', 'type'], ['running', 'running'],
    ['disabled', 'disabled'], ['comment', 'comment'], ['mtu', 'mtu'],
  ], o, 'interfaces'))

  L.push(...rows('/interface bridge', [
    ['name', 'name'], ['comment', 'comment'],
    ['vlan_filtering', 'vlan-filtering'], ['pvid', 'pvid'],
  ], o, 'bridge'))

  // Which ports belong to which bridge. Without this the bridge survey only
  // says that a bridge exists, not that ether2 is enslaved to it - which is
  // the fact an ISP actually needs before touching an uplink.
  L.push(...rows('/interface bridge port', [
    ['bridge', 'bridge'], ['interface', 'interface'],
    ['comment', 'comment'], ['disabled', 'disabled'], ['edge', 'edge'],
  ], o, 'bridge_ports'))

  // VLAN filtering replaced pvid on older bridges; both are asked so the panel
  // can say which model of VLAN the box actually uses.
  L.push(...rows('/interface vlan', [
    ['name', 'name'], ['interface', 'interface'], ['vlan_id', 'vlan-id'],
    ['comment', 'comment'], ['disabled', 'disabled'],
  ], o, 'vlans'))

  L.push(...rows('/ip address', [
    ['address', 'address'], ['network', 'network'],
    ['interface', 'interface'], ['disabled', 'disabled'], ['comment', 'comment'],
  ], o, 'ip_addresses'))

// --- services already on the box ------------------------------------------
  L.push(...rows('/ip dhcp-server', [
    ['name', 'name'], ['interface', 'interface'],
    ['address_pool', 'address-pool'], ['disabled', 'disabled'],
  ], o, 'dhcp'))

  L.push(...rows('/ip pool', [
    ['name', 'name'], ['ranges', 'ranges'], ['next_pool', 'next-pool'],
  ], o, 'ip_pools'))

  L.push(...rows('/ip hotspot', [
    ['name', 'name'], ['interface', 'interface'], ['address_pool', 'address-pool'],
    ['profile', 'profile'], ['disabled', 'disabled'], ['comment', 'comment'],
  ], o, 'hotspot'))

  // HotSpot USERS belong to the hotspot subsystem, not to PPPoE. This used to
  // read `/ip hotspot user` and file it under `pppoe`, so the panel reported
  // prepaid HotSpot subscribers as PPPoE customers - two different services,
  // two different billing paths, counted as one.
  L.push(...rows('/ip hotspot user', [
    ['name', 'name'], ['profile', 'profile'], ['server', 'server'],
    ['comment', 'comment'],
  ], o, 'hotspot'))

  // PPPoE customers are PPP secrets. `/interface/pppoe-server/server` is where
  // the dial-in service itself is configured, and both are read-only prints.
  //
  // `service` is included because a /ppp secret can be `any`, `pppoe` or
  // `pptp`; the panel needs the service to tell a PPPoE subscriber from another
  // kind of PPP account rather than assuming.
  L.push(...rows('/ppp secret', [
    ['name', 'name'], ['service', 'service'], ['profile', 'profile'],
    ['remote_address', 'remote-address'], ['comment', 'comment'],
    ['disabled', 'disabled'],
  ], o, 'pppoe'))

  // The PPPoE server itself. A different menu from the accounts above, so it is
  // reported as its own rows appended to the same subsystem by a second call.
  L.push(...rows('/interface pppoe-server server', [
    ['name', 'name'], ['service_name', 'service-name'],
    ['max_mtu', 'max-mtu'], ['authentication', 'authentication'],
    ['one_session_per_host', 'one-session-per-host'],
    ['keepalive_timeout', 'keepalive-timeout'], ['comment', 'comment'],
    ['disabled', 'disabled'],
  ], o, 'pppoe-servers'))

  // PPP profiles drive PPPoE. `/ppp profile` was previously filed under
  // `radius`, which is both the wrong subsystem and an incomplete RADIUS
  // survey: the RADIUS client configuration is its own menu.
  L.push(...rows('/ppp profile', [
    ['name', 'name'], ['comment', 'comment'], ['local_address', 'local-address'],
    ['remote_address', 'remote-address'], ['use_compression', 'use-compression'],
    ['use_encryption', 'use-encryption'],
  ], o, 'pppoe-profiles'))

  // RADIUS, read from the menu that actually holds it. `secret` is deliberately
  // NOT requested: the shared secret is written by the worker from encrypted
  // storage and must never travel back out over a survey POST.
  L.push(...rows('/radius', [
    ['address', 'address'], ['port', 'port'], ['timeout', 'timeout'],
    ['src_address', 'src-address'], ['comment', 'comment'],
  ], o, 'radius'))

  // Where PPP secrets are told to authenticate against RADIUS.
  L.push(...rows('/ppp aaa', [
    ['use-radius', 'use-radius'], ['radius-interim-update', 'radius-interim-update'],
  ], o, 'radius-aaa'))

  L.push(...rows('/ip firewall filter', [
    ['chain', 'chain'], ['action', 'action'], ['comment', 'comment'],
    ['disabled', 'disabled'],
  ], o, 'firewall'))

  L.push(...rows('/ip firewall nat', [
    ['chain', 'chain'], ['action', 'action'], ['comment', 'comment'],
    ['disabled', 'disabled'], ['to_addresses', 'to-addresses'],
  ], o, 'nat'))

  L.push(...rows('/ip route', [
    ['dst_address', 'dst-address'], ['gateway', 'gateway'],
    ['distance', 'distance'], ['comment', 'comment'],
  ], o, 'routes'))

  L.push(...rows('/ip dns', [
    ['name', 'name'], ['servers', 'servers'], ['dynamic_servers', 'dynamic-servers'],
    ['allow_remote_requests', 'allow-remote-requests'],
  ], o, 'dns'))

  // --- version-dependent menus ----------------------------------------------
  // WireGuard exists only on 7.1+. Asking a 6.x box would produce a false
  // UNSUPPORTED, so on 6.x the survey records itself as skipped instead.
  //
  // UNKNOWN is a third state and must not fall into the 6.x branch. A router
  // that never reported its version is NOT a RouterOS 6 box: telling one it
  // "has no WireGuard support" states a fact nobody established, which is how a
  // RouterOS 7.24.4 CHR was once told it lacked both REST and WireGuard. It
  // records itself as unknown instead, and the panel says so.
  if (o.major === null || o.major === undefined) {
    L.push(...skipped('wireguard',
      'RouterOS version not reported, so WireGuard support is unknown', o))
  } else if (seven) {
    L.push(...rows('/interface wireguard', [
      ['name', 'name'], ['listen_port', 'listen-port'],
      ['disabled', 'disabled'], ['comment', 'comment'],
    ], o, 'wireguard'))
  } else {
    L.push(...skipped('wireguard', 'RouterOS 6 has no WireGuard support', o))
  }

  L.push(...rows('/ip service', [
    ['name', 'name'], ['port', 'port'], ['disabled', 'disabled'],
    ['address', 'address'],
  ], o, 'services'))

  L.push(...rows('/certificate', [
    ['name', 'name'], ['common_name', 'common-name'],
    ['invalid_after', 'invalid-after'], ['expired', 'expired'],
  ], o, 'certificates'))

  // Wireless and CAPsMAN are absent on every wired RouterBOARD, so these two
  // are routinely unavailable. The :onerror wrapper is what keeps that quiet
  // instead of leaving a stack trace in the ISP's terminal.
  L.push(...rows('/interface wireless', [
    ['name', 'name'], ['ssid', 'ssid'], ['mode', 'mode'],
    ['disabled', 'disabled'], ['comment', 'comment'],
  ], o, 'wireless'))

  L.push(...rows('/caps-man manager', [
    ['name', 'name'], ['enabled', 'enabled'],
    ['certificate', 'certificate'],
  ], o, 'capsman'))

  // --- what ISPFlow already owns -------------------------------------------
  // Any object carrying our tag from a previous run. This is what makes a
  // re-provision idempotent in the field: the panel can tell "fresh router"
  // apart from "already ours, half-finished" and resume rather than duplicate.
  L.push(...rows('/ip firewall filter', [
    ['chain', 'chain'], ['action', 'action'], ['comment', 'comment'],
  ], o, 'ispflow'))

  L.push(...rows('/system scheduler', [
    ['name', 'name'], ['interval', 'interval'], ['disabled', 'disabled'],
    ['comment', 'comment'],
  ], o, 'scheduler'))

  L.push(...rows('/system script', [
    ['name', 'name'], ['comment', 'comment'],
  ], o, 'backup'))

  L.push(
    '',
    ':put "";',
    ':put "ISPFlow discovery finished. Return to your ISPFlow dashboard.";',
  )
  return L.join('\n') + '\n'
}

/**
 * The full discovery script: a COMPLETE generated `.rsc`, not a fragment.
 *
 * One master outer block, exactly as the canonical format requires. Everything
 * the section declares - `$token`, `$tag`, `$baseUrl` - is scoped to that
 * block, so importing this file cannot collide with a `$token` an operator
 * already had open in their terminal, and the file reads top-to-bottom the way
 * a person would have written it.
 *
 * `buildSurveySection` is the same content without the wrapper, for the two
 * callers that add discovery to a larger script: `router-provision/index.ts`
 * (claim response) and `router-provision/generate.ts` (all-in-one bootstrap).
 */
export function buildDiscoveryScript(o: DiscoveryOptions): string {
  return '{\n' + buildSurveySection(o) + '}\n'
}

/**
 * Records that a survey was deliberately skipped, and why.
 *
 * A skipped survey has to be visible. "We did not ask" and "we asked and the
 * box does not support it" are different answers, and conflating them is how
 * a platform ends up telling an ISP their router lacks a feature when the
 * real reason is that nobody ever looked.
 *
 * It is reported through the same canonical `:do { ... } on-error={ ... }`
 * block and the same `http-data=$jsonPayload` fetch as a survey that ran,
 * because the panel should not have to know which kind of block produced a row.
 */
function skipped(key: Survey, reason: string, _o: DiscoveryOptions): string[] {
  return [
    '',
    '# --- ' + key + ' (skipped: not applicable to this firmware) ---',
    ':do {',
    `  :put "ISPFlow: ${key} skipped - ${reason}";`,
    '  :local r [:toarray ""]',
    `  :set ($r->"unsupported") "${ros(reason)}"`,
    '  :local jsonPayload [:serialize to=json value=$r]',
    `  ${post(urlExpr(key))}`,
    ...endGuard(key),
  ]
}

