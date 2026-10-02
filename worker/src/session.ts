// =============================================================================
//  Session core - re-exported, not duplicated.
//
//  The implementation lives in supabase/functions/_shared/session.ts because the
//  Edge Function needs it too. Keeping one copy is not tidiness: the logic that
//  matches a `!done` sentence to the command waiting for it is the part most
//  likely to drift, and a drift shows up as a command returning another
//  command's rows, which reads as "the router is broken".
//
//  What the worker adds on top is the socket: raw TCP on 8728 or TLS on 8729,
//  kept open between polls. See raw-channel.ts.
// =============================================================================

export {
  RouterOsApi,
  RouterConnectError,
  DEFAULT_TIMEOUT,
  sentenceToMessage,
  isAlreadyExists,
  isAuthFailure,
  type ConnectionMethod,
  type WireChannel,
  type ApiOptions,
} from '../../supabase/functions/_shared/session.ts'
