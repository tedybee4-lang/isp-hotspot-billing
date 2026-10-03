// =============================================================================
//  Bearer-token authentication for Edge Functions deployed --no-verify-jwt.
//
//  Some functions must be reachable without a Supabase user session:
//
//    * pg_cron cannot present a JWT, so mikrotik-poll is scheduled with
//      --no-verify-jwt;
//    * a payment provider authenticates with an HMAC signature, not a session,
//      so hashback-webhook is deployed the same way.
//
//  --no-verify-jwt turns off the gateway's authentication, so the FUNCTION has
//  to authenticate its caller itself. Forgetting that does not fail closed: the
//  function simply runs, with the service role, for anyone who finds the URL.
//
//  Observed on production before this module existed - an unauthenticated GET
//  against the telemetry poller returned HTTP 200 and a summary of every router
//  in the platform, having decrypted each stored router password.
//
//  This is a separate module, not a helper inside the function, because it can
//  then be imported by the test suite. Importing mikrotik-poll itself would
//  execute Deno.serve and fail under Node.
// =============================================================================

/**
 * Constant-time string compare.
 *
 * A plain `===` returns at the first differing character, so its runtime leaks
 * how many leading characters of a secret were correct. That is enough to
 * recover a secret one character at a time. This accumulates differences across
 * every position without branching and is checked once at the end.
 *
 * The length check is deliberate and safe: a key's length is not itself secret,
 * and comparing it first avoids an out-of-bounds read below.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/**
 * True when the header carries a genuine service credential.
 *
 * `expectedKeys` is every service credential the platform is known to use.
 * Supabase exposes a legacy JWT (`SUPABASE_SERVICE_ROLE_KEY`, role
 * service_role) and, on newer projects, an `sb_secret_…` value. Which one a
 * given deployment injects is not something this function can predict, and
 * guessing fails closed but INVISIBLY: the scheduled poller keeps returning 401,
 * nobody notices, and every router slowly appears offline.
 *
 * Accepting a set rather than one literal is not a weakening. Every member is a
 * service credential that bypasses RLS and is only ever held by the platform; a
 * browser has none of them.
 *
 * Fails closed on an empty set: "no secret configured" is not authorisation.
 */
export function isAuthorised(
  authorizationHeader: string | null | undefined,
  expectedKeys: Array<string | null | undefined>,
): boolean {
  const candidates = expectedKeys.filter((k): k is string => Boolean(k))
  if (candidates.length === 0) return false
  const match = /^Bearer\s+(.+)$/i.exec((authorizationHeader ?? '').trim())
  if (!match) return false
  // A caller that supplies any one valid service credential is authorised.
  // `some` short-circuits, which is fine here: the compared material is the
  // CALLER's token, and every candidate is an equally long high-entropy secret,
  // so no meaningful information is leaked about the others.
  return candidates.some((k) => timingSafeEqualStr(match[1], k))
}

/** The single-key form, for callers that have exactly one service credential. */
export function isAuthorisedWith(
  authorizationHeader: string | null | undefined,
  expectedKey: string | null | undefined,
): boolean {
  return isAuthorised(authorizationHeader, [expectedKey])
}