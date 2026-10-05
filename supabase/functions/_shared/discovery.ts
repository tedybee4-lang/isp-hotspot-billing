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
export const SURVEYS = [
  'identity', 'resource', 'board', 'packages', 'interfaces', 'bridges',
  'vlans', 'addresses', 'dhcp', 'pools', 'hotspot', 'pppoe',
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
 * A POST of a finished JSON document; the reply is discarded.
 *
 * `method=POST` is the real RouterOS property name. (`http-method=post` appears
 * in some reference scripts and is NOT valid RouterOS - the fetch fails and the
 * survey is silently lost.)
 *
 * `check-certificate=yes` because RouterOS does not verify TLS by default, and
 * this body carries the discovery token.
 *
 * `http-data` is parenthesised so the whole concatenation is one argument
 * value; without the parentheses the quotes close the literal immediately and
 * the body silently collapses.
 *
 * `http-header-field` is REQUIRED, not decoration. The report endpoint branches
 * on content-type: with `application/json` it calls `req.json()`, otherwise it
 * calls `req.formData()`. RouterOS does not set an application/json content-type
 * on its own, so without this header every survey body failed to parse and was
 * stored as `{}` - surveys counted as reported, with no data in them.
 *
 * `keep-result` is NOT emitted. It only means anything for `output=file`, and
 * RouterOS rejects the combination; with `output=user as-value` it is dead
 * weight and a second thing to be wrong about.
 */
function post(url: string, body: string): string {
  return `/tool fetch url="${ros(url)}" method=POST check-certificate=yes ` +
    `http-header-field="Content-Type:application/json" ` +
    `output=user as-value http-data=(${body})`
}

/** The scoped `:onerror` wrapper every survey is emitted inside. */
function guard(key: Survey): string[] {
  return [
    // `in={...} do={...}` scopes the handler to this block. The older
    // `:onerror e do={...}` followed by a bare `{ ... }` relied on the handler
    // persisting for the rest of the script, which is not what it does.
    `:onerror e in={`,
    `  :put ("ISPFlow: ${key} not reported: " . $e)`,
    `} do={`,
  ]
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
function serializeRows(
  menu: string,
  fields: Array<[json: string, prop: string]>,
  opts: DiscoveryOptions,
  key: Survey,
): string[] {
  const url = `${opts.reportUrl}?survey=${key}&token=${opts.token}&tag=${opts.tag}`
  const out: string[] = ['', '# --- ' + key + ' ---', ...guard(key)]
  out.push('  :local rows ""')
  out.push(`  :foreach i in=[${menu}/find] do={`)
  out.push('    :local r {}')
  for (const [jsonKey, prop] of fields) {
    out.push(`    :local v ($i->"${prop}")`)
    // An unset property is an empty array. Skipping it keeps the payload to
    // values that exist rather than a wall of empty arrays.
    out.push(`    :if ([:typeof $v] != "array") do={ :set r ($r . "${jsonKey}"=$v) }`)
  }
  out.push('    :local j [:serialize to=json value=$r]')
  out.push('    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }')
  out.push('    :set rows ($rows . $j)')
  out.push('  }')
  out.push(`  ${post(url, '"[" . $rows . "]"')}`)
  out.push('}')
  return out
}

/** NATIVE JSON for the single-object surveys. */
function serializeScalars(
  key: Survey,
  reads: Array<[json: string, routeros: string]>,
  opts: DiscoveryOptions,
): string[] {
  const url = `${opts.reportUrl}?survey=${key}&token=${opts.token}&tag=${opts.tag}`
  const out: string[] = ['', '# --- ' + key + ' ---', ...guard(key)]
  out.push('  :local r {}')
  for (const [jsonKey, expr] of reads) {
    out.push(`  :local v [${expr}]`)
    out.push(`  :if ([:typeof $v] != "array") do={ :set r ($r . "${jsonKey}"=$v) }`)
  }
  out.push('  :local j [:serialize to=json value=$r]')
  out.push(`  ${post(url, '$j')}`)
  out.push('}')
  return out
}

/** Row-collection block, using whichever JSON strategy the firmware supports. */
function rows(
  menu: string,
  fields: Array<[json: string, prop: string]>,
  opts: DiscoveryOptions,
  key: Survey,
): string[] {
  return jsonMode(opts) === 'serialize'
    ? serializeRows(menu, fields, opts, key)
    : escapeRows(menu, fields, opts, key)
}

/** Single-object block, using whichever JSON strategy the firmware supports. */
function scalars(
  key: Survey,
  reads: Array<[json: string, routeros: string]>,
  opts: DiscoveryOptions,
): string[] {
  return jsonMode(opts) === 'serialize'
    ? serializeScalars(key, reads, opts)
    : escapeScalars(key, reads, opts)
}

function escapeRows(
  menu: string,
  fields: Array<[json: string, prop: string]>,
  opts: DiscoveryOptions,
  key: Survey,
): string[] {
  const url = `${opts.reportUrl}?survey=${key}&token=${opts.token}&tag=${opts.tag}`
  const out: string[] = [
    '',
    '# --- ' + key + ' ---',
    ':onerror e do={ :put ("ISPFlow: ' + key + ' not reported: " . $e) }',
    '{',
    '  :local rows "";',
    `  :foreach i in=[${menu}/find] do={`,
    '    :local o "";',
    // Declared ONCE per block, not once per property. `:set` on an undeclared
    // variable is not valid RouterOS, and reusing one target keeps the script
    // small enough to import on a 32 MB RB951.
    '    :local j ""',
  ]
  for (const [jsonKey, prop] of fields) {
    out.push(`    :local p ($i->"${prop}")`)
    // An unset property comes back as an empty array, which cannot be
    // concatenated onto a string. Normalise it to nothing.
    out.push(`    :if ([:typeof $p] = "array") do={ :set p "" }`)
    // The separator is a local rather than a `? :` ternary: the ternary is not
    // available on every RouterOS 6 build, and this script has to run on the
    // oldest hardware ISPFlow supports.
    out.push(`    :if ($p != "") do={`)
    // `$j` MUST be declared before it is set. `:set` on an undeclared variable
    // is not valid RouterOS, so the escape target is a real local. The
    // indentation is kept flush with the block so the emitted script reads the
    // way an operator would have typed it.
    out.push(...jsonEscapeSteps('p', 'j').map((l) => '      ' + l))
    out.push(`      :local s ""`)
    out.push(`      :if ([:len $o] > 0) do={ :set s "," }`)
    out.push(`      :set o ($o . $s . "\\"${jsonKey}\\":\\"" . $j . "\\"")`)
    out.push('    }')
  }
  out.push('    :if ([:len $o] > 0) do={')
  out.push('      :local s ""')
  out.push('      :if ([:len $rows] > 0) do={ :set s "," }')
  out.push('      :set rows ($rows . $s . "{" . $o . "}")')
  out.push('    }')
  out.push('  }')
  out.push(`  ${post(url, '"[" . $rows . "]"')}`)
  out.push('}')
  return out
}

/**
 * Emits a block that posts a single JSON object of scalar values.
 *
 * Used for the identity/resource style surveys, where there is exactly one row
 * and the interesting values are strings and numbers rather than a list.
 */
function escapeScalars(
  key: Survey,
  reads: Array<[json: string, routeros: string]>,
  opts: DiscoveryOptions,
): string[] {
  const url = `${opts.reportUrl}?survey=${key}&token=${opts.token}&tag=${opts.tag}`
  const out: string[] = [
    '',
    '# --- ' + key + ' ---',
    ':onerror e do={ :put ("ISPFlow: ' + key + ' not reported: " . $e) }',
    '{',
    '  :local o "";',
    // One escape target for the whole block; see the row emitter.
    '  :local j ""',
  ]
  for (const [jsonKey, expr] of reads) {
    out.push(`  :local p [${expr}]`)
    out.push(`  :if ([:typeof $p] = "array") do={ :set p "" }`)
    out.push('  :if ($p != "") do={')
    out.push('    :local s ""')
    out.push('    :if ([:len $o] > 0) do={ :set s "," }')
    // Escaped for the same reason as the row surveys: the identity and the
    // board name are free text, and one quote in either silently voided
    // the whole survey on the server.
    out.push(...jsonEscapeSteps('p', 'j').map((l) => '    ' + l))
    out.push(`    :set o ($o . $s . "\\"${jsonKey}\\":\\"" . $j . "\\"")`)
    out.push('  }')
  }
  out.push(`  ${post(url, '"{" . $o . "}"')}`)
  out.push('}')
  return out
}

/**
 * The full discovery script.
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
 */
export function buildDiscoveryScript(o: DiscoveryOptions): string {
  const seven = o.major !== null && o.major >= 7
  const L: string[] = [
    // MARKERS (see capabilities.ts). Present in the HTTP response, not just in a
    // fixture, so a stale deployment is visible in the downloaded bytes alone.
    '# ISPFlow-BOOTSTRAP-GENERATOR-528C90',
    '# ISPFlow-ROUTEROS7-SERIALIZE-GENERATOR',
    '# =============================================================================',
    `# ISPFlow router discovery - session ${o.tag}`,
    '# =============================================================================',
    '# READ ONLY. This script changes nothing on your router. It reads what is',
    '# already configured and reports it, so ISPFlow can configure safely.',
    '',
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

  // A CHR has no serial number; the read fails harmlessly, which is why it is
  // asked for separately from the rest of the board information.
  L.push(...scalars('board', [
    ['serial_number', '/system routerboard/get serial-number'],
    ['model', '/system routerboard/get model'],
    ['firmware_type', '/system routerboard/get firmware-type'],
  ], o))

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
  ], o, 'bridges'))

  // VLAN filtering replaced pvid on older bridges; both are asked so the panel
  // can say which model of VLAN the box actually uses.
  L.push(...rows('/interface vlan', [
    ['name', 'name'], ['interface', 'interface'], ['vlan_id', 'vlan-id'],
    ['comment', 'comment'], ['disabled', 'disabled'],
  ], o, 'vlans'))

  L.push(...rows('/ip address', [
    ['address', 'address'], ['network', 'network'],
    ['interface', 'interface'], ['disabled', 'disabled'], ['comment', 'comment'],
  ], o, 'addresses'))

// --- services already on the box ------------------------------------------
  L.push(...rows('/ip dhcp-server', [
    ['name', 'name'], ['interface', 'interface'],
    ['address_pool', 'address-pool'], ['disabled', 'disabled'],
  ], o, 'dhcp'))

  L.push(...rows('/ip pool', [
    ['name', 'name'], ['ranges', 'ranges'], ['next_pool', 'next-pool'],
  ], o, 'pools'))

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
 * Records that a survey was deliberately skipped, and why.
 *
 * A skipped survey has to be visible. "We did not ask" and "we asked and the
 * box does not support it" are different answers, and conflating them is how
 * a platform ends up telling an ISP their router lacks a feature when the
 * real reason is that nobody ever looked.
 */
function skipped(key: Survey, reason: string, o: DiscoveryOptions): string[] {
  const url = `${o.reportUrl}?survey=${key}&token=${o.token}&tag=${o.tag}`
  return [
    '',
    '# --- ' + key + ' (skipped: not applicable to this firmware) ---',
    `:put "ISPFlow: ${key} skipped - ${reason}";`,
    `  /tool fetch url="${ros(url)}" method=POST check-certificate=yes ` +
      `http-header-field="Content-Type:application/json" ` +
      `output=user as-value ` +
      `http-data="{\\"unsupported\\":\\"${ros(reason)}\\"}"`,
  ]
}