// =============================================================================
//  router-provision/generate.ts - THE canonical all-in-one provisioning script
//
//  Served by `GET /functions/v1/router-provision/generate?token=TOKEN`, the URL
//  the panel hands the operator as a single copy-paste line:
//
//    /tool fetch mode=https url=".../router-provision/generate?token=TOKEN" \
//      dst-path=ispflow-bootstrap.rsc; \
//    /import file-name=ispflow-bootstrap.rsc verbose=yes dry-run; \
//    /import file-name=ispflow-bootstrap.rsc;
//
//  ONE file, ONE execution. The router downloads it, dry-runs it, runs it, and
//  by the time it prints the closing line it has:
//
//    1. enabled the management services the platform needs,
//    2. surveyed itself back to `/report` - identity, resources, interfaces,
//       bridge, bridge_ports, addresses, routes, HotSpot, PPPoE, pools, DHCP,
//       firewall, services and what ISPFlow already owns,
//    3. installed the HotSpot / PPPoE pools, profiles, walled garden and the
//       RADIUS client - every one guarded by an existence check, so a second
//       run changes nothing,
//    4. installed the heartbeat script and its scheduler.
//
//  CANONICAL FORMAT - non-negotiable, asserted by generate.test.ts:
//
//    * the whole file is one master outer block `{ ... }`,
//    * every map is `:local r [:toarray ""]`,
//    * every survey and every service block is
//        :do { ... } on-error={ :put "ISPFlow: <step> skipped/failed" },
//    * every POST fetch is
//        /tool fetch mode=https url=(...) http-method=post check-certificate=yes
//          http-header-field="Content-Type:application/json" output=none
//          http-data=$jsonPayload;
//    * RouterOS 7.13+ uses `:serialize`; older versions use JSON-safe
//      `:replace` escaping. Every CLI menu path is space-delimited.
//
//  JSON strategy is selected from the reported RouterOS version: native
//  serialization where supported, the compatible escape path on older
//  versions, and the conservative escape path when the version is unknown.
// =============================================================================

import {
  buildSurveySection,
  ros,
  sessionLocals,
  type DiscoveryOptions,
} from '../_shared/discovery.ts'

/**
 * The heartbeat source, as it must appear inside `/system script add source=`.
 *
 * Double-escaped on purpose: the value is a RouterOS string that CONTAINS a
 * RouterOS string, so every quote in it is `\"` in the outer literal. The URL
 * is interpolated directly rather than via `$pingUrl`, because `source=` is
 * stored text that is re-parsed when the scheduler fires - a local declared
 * here would not be in scope there.
 */
function heartbeatSource(o: GenerateOptions): string {
  const url = ros(pingUrl(o.reportUrl))
  return `/tool fetch mode=https url=\\"${url}\\" http-method=post check-certificate=yes ` +
    `http-header-field=\\"Content-Type:application/json\\" output=none http-data=\\"{}\\"`
}

/**
 * Present in every download, so "is production serving the canonical
 * generator?" is answered by the bytes alone rather than by a deploy log.
 */
export const GENERATE_MARKER = '# ISPFlow-CANONICAL-GENERATOR-ALLINONE'

export interface GenerateOptions {
  /** The short-lived discovery credential every survey POST authenticates with. */
  token: string
  /** Session tag, so two routers provisioning at once stay apart. */
  tag: string
  /** Absolute `/router-provision/report` URL. `/ping` is derived from it. */
  reportUrl: string
  /** RouterOS version reported by the bootstrap request, when known. */
  major?: number | null
  minor?: number | null
  architecture?: string | null
  /**
   * RADIUS client to install, when the panel has one to give.
   *
   * Left null - the normal case for a bootstrap - and the block reports that it
   * did nothing rather than inventing a server address. A `/radius add` with a
   * guessed address and an empty secret is worse than no RADIUS at all: it
   * silently breaks PPPoE authentication on a live network.
   */
  radius?: { address: string; secret: string; service?: string } | null
}

/** The heartbeat URL, derived so the two endpoints cannot drift apart. */
export function pingUrl(reportUrl: string): string {
  return reportUrl.replace(/\/report$/, '/ping')
}

/**
 * The canonical idempotency guard.
 *
 * `:if ([:len [/path find name="x"]] = 0) do={ ... }` - check, then create.
 * Every object this script creates sits inside one, which is what makes the
 * command safe to paste twice: the second run finds each object already there
 * and creates nothing.
 *
 * @param menu   the menu to search, e.g. `/ip pool`
 * @param match  the `find` predicate WITHOUT brackets, e.g. `name="ispflow-hotspot-pool"`
 * @param add    the creation command
 * @param indent leading whitespace of the guard line
 */
export function ensure(menu: string, match: string, add: string, indent = '    '): string[] {
  return [
    `${indent}:if ([:len [${menu} find ${match}]] = 0) do={`,
    `${indent}    ${add}`,
    `${indent}};`,
  ]
}

/**
 * The complete bootstrap script.
 *
 * Sections run in the order the canonical template specifies: session locals,
 * services, identity, survey, installation, heartbeat. The survey comes BEFORE
 * the installation on purpose - what a router already has has to reach the
 * panel before anything is added to it.
 */
export function buildGenerateScript(o: GenerateOptions): string {
  const discovery: DiscoveryOptions = {
    reportUrl: o.reportUrl,
    token: o.token,
    // Unknown versions use the RouterOS 6-compatible JSON escape path and do
    // not receive version-specific menus. The claim path supplies these values
    // directly from the router before generating its script.
    major: o.major ?? null,
    minor: o.minor ?? null,
    architecture: o.architecture,
    tag: o.tag,
  }

  const L: string[] = [
    '# ISPFlow-BOOTSTRAP-GENERATOR-528C90',
    '# ISPFlow-ROUTEROS7-SERIALIZE-GENERATOR',
    GENERATE_MARKER,
    `# ISPFlow canonical provisioning bootstrap - session ${o.tag}`,
    '# Complete and all-in-one: discover, configure, install. Runs once.',
    '',
    '{',
    // --- 0. session locals ---------------------------------------------------
    // Declared once here rather than inlined into thirty fetch URLs. This is
    // why `buildSurveySection` is called with `declareLocals: false`.
    ...sessionLocals(o).map((l) => '  ' + l),
    '',
    '  # 1. Enable Required Management Services',
    '  :if ([:len [/ip service find name="api"]] = 0) do={ /ip service add name="api" port=8728 };',
    '  :if ([:len [/ip service find name="api-ssl"]] = 0) do={ /ip service add name="api-ssl" port=8729 };',
    '  :if ([:len [/ip service find name="www-ssl"]] = 0) do={ /ip service add name="www-ssl" port=8080 };',
    '',
    '  :local sysIdentity [/system identity get name];',
    '  :local sysVersion [/system resource get version];',
    '  :local sysBoard [/system resource get board-name];',
    '',
    '  :put ("ISPFlow: Router identity is " . $sysIdentity . ", RouterOS " . $sysVersion . " on " . $sysBoard);',
    '  :put "Starting survey upload...";',
    '',
    '  # 2-6. Discovery surveys. Each one is its own :do / on-error block, so a',
    '  #      menu this firmware does not have costs one line of output.',
    '',
  ]

  // --- 2..6 discovery surveys ------------------------------------------------
  // Re-indented by two spaces so the section reads as part of the master block.
  L.push(...buildSurveySection(discovery, false)
    .split('\n')
    .map((line) => (line.length ? '  ' + line : line)))

  L.push(
    '',
    '  # 7. HotSpot & PPPoE Service Configuration Block (Idempotent)',
    '  :do {',
    '    # IP Pools',
    ...ensure('/ip pool', 'name="ispflow-hotspot-pool"',
      '/ip pool add name="ispflow-hotspot-pool" ranges=10.5.5.2-10.5.5.254 comment="ISPFlow HotSpot Pool";'),
    ...ensure('/ip pool', 'name="ispflow-pppoe-pool"',
      '/ip pool add name="ispflow-pppoe-pool" ranges=10.10.0.2-10.10.3.254 comment="ISPFlow PPPoE Pool";'),
    '',
    '    # HotSpot Profile & Server',
    ...ensure('/ip hotspot profile', 'name="ispflow-hs-profile"',
      '/ip hotspot profile add name="ispflow-hs-profile" hotspot-address=10.5.5.1 login-by=http-chap,http-pap use-radius=yes comment="ISPFlow HotSpot Profile";'),
    '',
    '    # PPPoE Server & Profile',
    ...ensure('/ppp profile', 'name="ispflow-pppoe-profile"',
      '/ppp profile add name="ispflow-pppoe-profile" local-address=10.10.0.1 remote-address=ispflow-pppoe-pool use-ipv6=no comment="ISPFlow PPPoE Profile";'),
    ...ensure('/interface pppoe-server server', 'service-name="ispflow"',
      '/interface pppoe-server/server add service-name=ispflow interface=bridge profile=ispflow-pppoe-profile comment="ISPFlow PPPoE Server";'),
    '',
    '    # Default Walled Garden Rule for ISPFlow Portal',
    ...ensure('/ip hotspot walled-garden', 'dst-host="*.ispflow.co*"',
      '/ip hotspot walled-garden add dst-host="*.ispflow.co*" action=allow comment="ISPFlow Portal Access";'),
    '  } on-error={',
    '    :put "ISPFlow: Hotspot and PPPoE service configuration skipped/failed"',
    '  };',
    '',
    '  # 7b. RADIUS settings (Idempotent)',
    '  :do {',
    ...radiusBlock(o),
    '  } on-error={',
    '    :put "ISPFlow: radius configuration skipped/failed"',
    '  };',
    '',
    '  # 8. Install ISPFlow Heartbeat Script & Scheduler (Idempotent)',
    '  :do {',
    ...ensure('/system script', 'name="ispflow-heartbeat"',
      `/system script add name="ispflow-heartbeat" comment="ISPFlow Service Script" source="${heartbeatSource(o)}"`),
    ...ensure('/system scheduler', 'name="ispflow-heartbeat-job"',
      '/system scheduler add name="ispflow-heartbeat-job" comment="ISPFlow Heartbeat Schedule" interval=1m on-event="ispflow-heartbeat";'),
    '  } on-error={',
    '    :put "ISPFlow: service heartbeat installation skipped/failed"',
    '  };',
    '',
    '  :put "ISPFlow survey upload and service installation completed successfully.";',
    '}',
    '',
  )

  return L.join('\n')
}


/**
 * The RADIUS half of the installation.
 *
 * Guarded twice over: the whole thing sits in a `:do`, and each create is an
 * `ensure`. With no server supplied it prints why and changes nothing - an
 * invented RADIUS client would silently break PPPoE authentication on a live
 * network, which is not a failure mode worth saving one line of output for.
 *
 * The secret goes into the router's own `/radius` entry and is never surveyed
 * back out: the RADIUS survey asks for address, port, timeout and comment
 * only.
 */
function radiusBlock(o: GenerateOptions): string[] {
  if (!o.radius) {
    return [
      '    :put "ISPFlow: no RADIUS server in this bootstrap; the panel will add the client later.";',
    ]
  }
  const address = ros(o.radius.address)
  const secret = ros(o.radius.secret)
  const service = o.radius.service ?? 'hotspot,ppp'
  return [
    '    # The RADIUS client. `service=` scopes it to the two services that use it.',
    ...ensure('/radius', `address="${address}"`,
      `/radius add address=${address} secret="${secret}" service=${service} comment="ISPFlow RADIUS"`),
    // NOT wrapped in `ensure`: `/ppp aaa` is a singleton configuration menu, not
    // a list of named objects, so there is no `find name=` to test. `set` on a
    // singleton is idempotent by construction - running it twice changes nothing.
    '    /ppp aaa set use-radius=yes',
  ]
}
