// =============================================================================
//  stk-push - RETIRED. Always answers 410 Gone.
//
//  This was the Safaricom Daraja STK Push endpoint. Daraja is no longer an M-Pesa
//  payment provider for this platform: automated collection runs through
//  HashBack (see the `hashback-stk` function).
//
//  The whole Daraja implementation that used to live below - OAuth token
//  exchange, the /mpesa/stkpush/v1/processrequest call, the per-tenant consumer
//  key / secret / passkey lookup - has been deleted rather than left behind the
//  gate. It was unreachable, and unreachable payment code is still payment code:
//  it keeps the credential-reading path alive in the repository and gives a
//  future editor something to re-enable by accident.
//
//  The function is retained as a refusal so an old integration gets an explicit
//  "this is finished" instead of a 404 that looks like a typo. 410 Gone rather
//  than 404 Not Found, because those mean different things to a caller.
//
//  Deploy:  supabase functions deploy stk-push --no-verify-jwt
// =============================================================================

const DARAJA_CUTOVER_REFUSAL =
  'Daraja payments are no longer accepted. Use the HashBack payment flow.'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })

Deno.serve(() =>
  json(
    {
      error: DARAJA_CUTOVER_REFUSAL,
      deprecated: true,
      removed: true,
      use: 'hashback-stk',
    },
    410,
  ),
)
