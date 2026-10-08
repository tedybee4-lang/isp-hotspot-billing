// =============================================================================
//  Router-side heartbeat: the script, the install block, and the URL.
//
//  The worker polls routers over the API, which is the primary liveness path.
//  What lives here is the OTHER direction: a scheduler on the router itself
//  POSTing to `/functions/v1/router-provision/ping`, which is what matters when
//  the worker cannot reach the router but the router can reach the internet
//  (task section 23).
//
//  Shared by `router-provision/generate.ts` (the canonical all-in-one
//  bootstrap) and the network worker's heartbeat stage, so there is exactly
//  ONE heartbeat shape in the system however a router was provisioned - and
//  therefore never two schedulers fighting over one device.
//
//  Credential rules:
//    * the token travels in the URL query - it is the router's own secret,
//      held on the router itself, exactly like the discovery token;
//    * the body carries only read-only facts read AT SEND TIME;
//    * no credential -> no install, and the script SAYS it skipped: a
//      scheduled POST the endpoint would reject is a dead job, and a dead job
//      that looks installed is exactly the fake state the spec forbids.
// =============================================================================

/**
 * The heartbeat URL, derived from the survey URL so the two endpoints cannot
 * drift apart.
 */
export function pingUrl(reportUrl: string): string {
  return reportUrl.replace(/\/report$/, '/ping')
}

/**
 * Escapes stored script text for embedding inside a `source="..."` literal.
 *
 * The heartbeat source is a RouterOS script that itself contains quoted JSON
 * and a quoted URL, so it passes through TWO parsers: first the `source="..."`
 * string of `/system script add`, then the script text when the scheduler
 * runs it. Every backslash is doubled and every quote escaped, in that order -
 * the same two-level scheme stages-script.ts uses for its own stored source.
 */
export function embedInSource(stored: string): string {
  return stored.split('\\').join('\\\\').split('"').join('\\"')
}

/**
 * The heartbeat source: what `/system script add source=` must hold.
 *
 * The body is assembled inside RouterOS at SEND time so uptime and free memory
 * are current when the scheduler fires - and so nothing is interpolated from a
 * local here, because `source=` is stored text re-parsed later: a local
 * declared in this generator would not be in scope when the script runs.
 *
 * If the router's identity contains a quote the body can come out as invalid
 * JSON; the endpoint treats an unparseable body as empty and still records the
 * heartbeat from the token, because a liveness signal that arrives beats a
 * perfect one that does not.
 */
export function heartbeatSource(o: { reportUrl: string; heartbeatToken?: string | null }): string {
  const base = o.reportUrl.replace(/\/report$/, '')
  const token = o.heartbeatToken ?? ''
  const url = base + '/ping?token=' + token
  // Number UNQUOTED so free_memory arrives as a JSON number for the bigint
  // column; identity/version/uptime are quoted strings.
  const body = String.raw`("{\"identity\":\"" . [/system identity get name] . \"\",\"version\":\"" . [/system resource get version] . \"\",\"uptime\":\"" . [/system resource get uptime] . \"\",\"free_memory\":" . [/system resource get free-memory] . "}")`
  const ping = `/tool fetch mode=https url="${url}" http-method=post check-certificate=yes ` +
    `http-header-field="Content-Type:application/json" output=none http-data=${body}`
  if (!o.heartbeatToken) return ping

  // The response to the heartbeat stays liveness-only. A separate authenticated
  // GET returns a bounded RouterOS script, so proxies and stale clients cannot
  // make the ping body itself executable.
  const poll = `/tool fetch mode=https url="${base}/commands?token=${token}" ` +
    'check-certificate=yes output=file dst-path=ispflow-command.rsc; ' +
    '/import file-name=ispflow-command.rsc; ' +
    '/file remove ispflow-command.rsc'
  return `${ping}; :do { ${poll}; } on-error={ :put "ISPFlow: command poll failed; will retry."; }`
}
