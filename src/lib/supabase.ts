import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { config, IS_LIVE } from './config'

/**
 * Supabase client, or null in demo mode.
 *
 * `persistSession` + `autoRefreshToken` are left on so the session survives
 * a page refresh in live mode.
 */
export const supabase: SupabaseClient | null = IS_LIVE
  ? createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'pkce',
      },
    })
  : null

export function requireSupabase(): SupabaseClient {
  if (!supabase) {
    throw new Error('Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.')
  }
  return supabase
}

/** Absolute URL of a deployed Edge Function. */
export function functionsUrl(name: string): string {
  return `${config.supabaseUrl}/functions/v1/${name}`
}