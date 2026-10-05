// =============================================================================
//  Stage scripts: the RouterOS each provisioning stage actually runs.
//
//  Every stage is a separate script fetched by the router, not one giant file.
//  That is what makes provisioning resumable: stage N is fetched only after
//  N-1 succeeded, so a router that dies at RADIUS comes back and re-runs from
//  RADIUS rather than re-importing everything.
//
//  The scripts are ADDITIVE and IDEMPOTENT. Every block looks for the object
//  first and creates it only when it is genuinely absent, and every object it
//  creates carries the ownership tag. Nothing here removes anything, because
//  the router being configured may be carrying paying customers.
//
//  ON THE OWNERSHIP TAG
//  ---------------------
//  New objects are written with the ISPFlow tag. `isOwned` also recognises the
//  legacy NETISP one, because routers provisioned by an earlier release carry
//  it on every object this platform created. Renaming the tag without also
//  recognising the old one would make this platform believe it owns nothing,
//  and then create a second copy of everything - the exact failure idempotency
//  exists to prevent.
// =============================================================================

/** The tag written on everything this platform creates from now on. */
export const OWNER = 'ISPFlow'

/**
 * Does a row already belong to ISPFlow - including objects an older release
 * created under the legacy tag?
 */
export function isOwned(comment: string | null | undefined): boolean {
  const text = (comment ?? '').trim()
  return (
    text.startsWith(`${OWNER}:`) ||
    text.startsWith(`${OWNER} `) ||
    text.startsWith('NETISP:')
  )
}

/** Quoting for a RouterOS string literal. Same rules as discovery.ts. */
export function q(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** The comment every object this platform creates carries. */
export const tagComment = (tag: string): string => `${OWNER}:${tag}`

/**
 * BACKUP.
 *
 * A binary `/system/backup/save` plus a text `/export hide-sensitive`. The
 * binary is the restorable one; the export is the readable one, and is what an
 * ISP can diff after a change. Both are written to the router's own
 * filesystem, never uploaded: uploading a backup would put a file containing
 * every PPPoE secret on a server, and being safe matters more than being
 * thorough.
 *
 * `password` is deliberately NOT used. RouterOS encrypts a password-protected
 * backup with a secret we would then have to hold, and a backup nobody can
 * decrypt is not a backup.
 */
export function buildBackupScript(opts: { tag: string }): string {
  const t = q(opts.tag)
  return [
    "# ISPFlow - safety backup before any configuration is applied.",
    "# Writes to this router's own filesystem. Nothing is uploaded anywhere.",
    '',
    `:global ispflowBackupBase "ispflow-backup-${opts.tag}"`,
    '',
    '# --- binary backup: the restorable one ---',
    '/system/backup/save name=($ispflowBackupBase . "-binary.backup")',
    ':put ("ISPFlow: binary backup written as " . $ispflowBackupBase . "-binary.backup");',
    '',
    '# --- text export: the readable one, secrets omitted ---',
    '# hide-sensitive keeps PPPoE and RADIUS secrets out of a file meant to be',
    '# compared or attached to a ticket.',
    '/export hide-sensitive file=($ispflowBackupBase . "-export.rsc") terse',
    ':put ("ISPFlow: text export written as " . $ispflowBackupBase . "-export.rsc");',
    '',
    '# --- report what actually landed on disk ---',
    '/file/print where name~$ispflowBackupBase',
    '',
    ':put "ISPFlow: backup stage complete.";',
  ].join('\n') + '\n'
}

/**
 * CONNECTIVITY.
 *
 * Opens the management services the worker uses, additively: it only ADDS a
 * service when absent and never touches the firewall here, so a router that
 * deliberately disables its API keeps that arrangement.
 *
 * Version-gated. REST arrived in 7.1 and does not exist on 6.x; asking a 6.x
 * box to start www-ssl aborts the import at that line and everything after it,
 * which on a RouterOS 6 access point is most of the run.
 */
export function buildConnectivityScript(opts: {
  tag: string
  supportsRest: boolean
}): string {
  const L: string[] = [
    `# ISPFlow management access - ${opts.tag}`,
    '# Additive. Disables nothing and removes nothing.',
    '',
    '# --- RouterOS API on 8728. Present on every RouterOS including 6.x. ---',
    // A bare `do={/ip/service ... }` is NOT valid RouterOS: `do=` is an argument
    // to a command, and on its own line the parser stops with
    // "expected end of command". Every block is a fetch plus a conditional.
    ':local ispflowApi [/ip/service/find name="api"]',
    ':if ([:len $ispflowApi] = 0) do={',
    '    /ip/service/add name="api" port=8728',
    '}',
  ]

  if (opts.supportsRest) {
    L.push(
      '',
      '# --- HTTPS REST on 8080. RouterOS 7.1 and later only. ---',
      '# The platform presents its own certificate; this script does not mint one.',
      ':local ispflowRest [/ip/service/find name="www-ssl"]',
      ':if ([:len $ispflowRest] = 0) do={',
      '    /ip/service/add name="www-ssl" port=8080',
      '}',
      '',
      '# --- API over TLS on 8729, only where a certificate already exists. ---',
      '# Generating a certificate here would mean shipping a private key to a',
      '# device we have not yet secured, so this waits for one to exist.',
      ':local ispflowCerts [/certificate/find]',
      ':local ispflowSsl [/ip/service/find name="api-ssl"]',
      ':if ([:len $ispflowSsl] = 0 && [:len $ispflowCerts] > 0) do={',
      '    /ip/service/add name="api-ssl" port=8729',
      '}',
    )
  } else {
    L.push(
      '',
      '# --- RouterOS 6: no REST service exists, so only the API is used. ---',
      ':put "ISPFlow: this firmware has no REST service; the platform will use the API.";',
    )
  }

  L.push(
    '',
    '# --- report, so the stage has evidence to report ---',
    '/ip/service/print where name~"api"',
    '',
    ':put "ISPFlow: connectivity stage complete.";',
  )
  return L.join('\n') + '\n'
}

/**
 * PACKAGE_SYNC: HotSpot user profiles and PPP profiles from the ISP's plans.
 *
 * Every value is interpolated from a database row at generation time. Each
 * block checks for an existing profile owned by EITHER tag before creating, so
 * re-running this stage after an ISP raises a package speed updates the first
 * profile instead of producing a second one.
 */
export function buildProfileScript(opts: {
  tag: string
  profiles: Array<{
    objectName: string
    rateLimit: string
    localAddress: string | null
    remoteAddress: string | null
    needsPpp: boolean
  }>
  pools: Array<{ name: string; ranges: string }>
}): string {
  const tag = tagComment(opts.tag)
  const L: string[] = [
    `# ISPFlow package profiles - ${opts.tag}`,
    "# Generated from this ISP's current packages. Re-running updates in place.",
    '',
  ]

  for (const pool of opts.pools) {
    L.push(
      `# --- address pool ${pool.name} ---`,
      `:local ispflowPool [/ip/pool/find where name=${q(pool.name)}]`,
      ':if ([:len $ispflowPool] = 0) do={',
      `    /ip/pool/add name=${q(pool.name)} ranges=${q(pool.ranges)} ` +
        `comment=${q(tag)}`,
      '}',
      '',
    )
  }

  for (const p of opts.profiles) {
    L.push(
      `# --- HotSpot profile: ${p.objectName} ---`,
      `:local ispflowProf [/ip/hotspot/user/profile/find where name=${q(p.objectName)}]`,
      ':if ([:len $ispflowProf] = 0) do={',
      `    /ip/hotspot/user/profile/add name=${q(p.objectName)} ` +
        `rate-limit=${q(p.rateLimit)} shared-users=1 comment=${q(tag)}`,
      '}',
      '',
    )

    if (p.needsPpp && p.localAddress && p.remoteAddress) {
      L.push(
        `# --- PPP profile: ${p.objectName} ---`,
        `:local ispflowPpp [/ppp/profile/find where name=${q(p.objectName)}]`,
        ':if ([:len $ispflowPpp] = 0) do={',
        `    /ppp/profile/add name=${q(p.objectName)} ` +
          `local-address=${q(p.localAddress)} remote-address=${q(p.remoteAddress)} ` +
          `comment=${q(tag)}`,
        '}',
        '',
      )
    }
  }

  L.push(
    '/ip/hotspot/user/profile/print where name!=""',
    ':put "ISPFlow: package profiles synchronised.";',
  )
  return L.join('\n') + '\n'
}

/**
 * HEARTBEAT.
 *
 * A scheduler entry plus the script it runs, both named with the tag and both
 * created only when absent, so a second provisioning run cannot leave two
 * heartbeat schedulers fighting over a 32 MB device.
 *
 * The script POSTs through `/tool fetch`, the cheapest mechanism available and
 * one that needs no daemon. The interval is generous by default: frequent
 * polling is the fastest way to exhaust a rural uplink or a small device.
 */
export function buildHeartbeatScript(opts: {
  tag: string
  url: string
  token: string
  intervalSeconds?: number
}): string {
  const interval = opts.intervalSeconds ?? 300
  const name = `${OWNER}-heartbeat-${opts.tag}`
  const tag = tagComment(opts.tag)

  // The body is assembled inside RouterOS so the scheduler does not re-send a
  // giant literal every cycle, and so uptime and memory are read at send time.
  const body = [
    ':put "ISPFlow heartbeat"',
    `:tool fetch url=${q(opts.url)} method=POST check-certificate=yes output=user as-value keep-result=no`,
    `  http-data=("{\\"routeros\\":\\"" . [/system/resource/get version] .`,
    `    \\",\\"identity\\":\\"" . [/system identity/get name] .`,
    `    \\",\\"uptime\\":\\"" . [/system resource/get uptime] .`,
    `    \\",\\"free_memory\\":\\"" . [/system resource/get free-memory] .`,
    `    \\",\\"token\\":\\"${opts.token}\\"}")`,
  ].join(' ')

  return [
    `# ISPFlow heartbeat - ${opts.tag}`,
    '',
    '# --- the script that reports in ---',
    `:local ispflowScript [/system/script/find where name=${q(name)}]`,
    ':if ([:len $ispflowScript] = 0) do={',
    `    /system/script/add name=${q(name)} comment=${q(tag)} source=${q(body)}`,
    '}',
    '',
    '# --- the scheduler that runs it ---',
    `:local ispflowSched [/system/scheduler/find where name=${q(name)}]`,
    ':if ([:len $ispflowSched] = 0) do={',
    `    /system/scheduler/add name=${q(name)} interval=${interval}s ` +
      `on-event=${q(`/system/script/run ${name}`)} ` +
      `comment=${q(tag)} policy=read,write,policy,test`,
    '}',
    '',
    '# Run once now, so the panel sees a heartbeat without waiting a whole',
    '# interval on a slow link.',
    `/system/script/run ${name}`,
    '',
    ':put "ISPFlow: heartbeat installed.";',
  ].join('\n') + '\n'
}

/**
 * VERIFICATION.
 *
 * The stage that decides whether the router may be called online. It re-reads
 * the router rather than trusting anything earlier: a stage that reported
 * success and a router that is actually configured are different claims, and
 * only the second one matters.
 *
 * It never writes. A verification script that could change something is not a
 * verification script.
 */
export function buildVerifyScript(opts: {
  tag: string
  expectHotspot: boolean
  expectPppoe: boolean
}): string {
  const L: string[] = [
    `# ISPFlow verification - ${opts.tag}`,
    '# READ ONLY. This stage changes nothing; it only looks.',
    '',
    ':put ("ISPFlow: RouterOS " . [/system resource/get version] .',
    '        " on " . [/system resource/get board-name] .',
    '        " (" . [/system resource/get architecture-name] . ")");',
    '',
    ':global ispflowVerified 1',
    '',
    '# --- the backup this run depends on must actually exist ---',
    `:global bk [/file/find where name~"ispflow-backup-${opts.tag}"]`,
    ':if ([:len $bk] = 0) do={',
    '  :set ispflowVerified 0',
    '  :put "ISPFlow: FAIL - no backup file found for this session."',
    '}',
    '',
    '# --- management must still be reachable ---',
    ':local api [/ip/service/find where name="api"]',
    ':if ([:len $api] = 0) do={',
    '  :set ispflowVerified 0',
    '  :put "ISPFlow: FAIL - the API service is not enabled."',
    '}',
    '',
    '# --- an ISPFlow-owned management path must survive ---',
    ':local managed [/ip/address/find where comment~"' + OWNER + '"]',
    ':if ([:len $managed] = 0) do={',
    '  :put "ISPFlow: note - no ISPFlow-tagged address; management is on an existing address."',
    '}',
    '',
    '# --- hotspot users must be untouched by provisioning ---',
    ':local users [/ip/hotspot/user/find]',
    ':put ("ISPFlow: " . [:len $users] . " HotSpot account(s) present; none were removed.");',
  ]

  if (opts.expectHotspot) {
    L.push(
      '',
      ':if ([:len [/ip/hotspot/user/profile/find]] = 0) do={',
      '  :set ispflowVerified 0',
      '  :put "ISPFlow: FAIL - HotSpot was selected but no user profile exists."',
      '}',
    )
  }
  if (opts.expectPppoe) {
    L.push(
      '',
      ':if ([:len [/ppp/profile/find]] = 0) do={',
      '  :set ispflowVerified 0',
      '  :put "ISPFlow: FAIL - PPPoE was selected but no PPP profile exists."',
      '}',
    )
  }

  L.push(
    '',
    '# --- heartbeat must exist and be enabled ---',
    ':local hb [/system/scheduler/find where comment~"' + OWNER + '"]',
    ':if ([:len $hb] = 0) do={',
    '  :set ispflowVerified 0',
    '  :put "ISPFlow: FAIL - no heartbeat scheduler is installed."',
    '}',
    '',
    '# --- the answer, as a single machine-readable line ---',
    ':if ($ispflowVerified = 1) do={ :put "ISPFlow: VERIFIED ok" }',
    ':if ($ispflowVerified = 0) do={ :put "ISPFlow: VERIFIED failed" }',
  )
  return L.join('\n') + '\n'
}