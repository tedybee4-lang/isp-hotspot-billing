/**
 * Runtime configuration.
 *
 * The app runs in one of two modes:
 *   • live  — real Supabase project (VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY)
 *   • demo  — no backend configured; an in-browser store simulates the whole
 *             platform so you can click through everything on localhost.
 *
 * Set the two VITE_SUPABASE_* vars in `.env.local` to switch to live mode.
 */
const rawUrl = (import.meta.env.VITE_SUPABASE_URL ?? '').trim()
const rawKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim()

/** A placeholder key is present in some templates — treat it as unconfigured. */
const looksReal = (v: string) => v.length > 20 && !v.includes('your-project') && !v.includes('xxxx')

export const IS_LIVE = looksReal(rawUrl) && looksReal(rawKey)

export const config = {
  mode: (IS_LIVE ? 'live' : 'demo') as 'live' | 'demo',
  supabaseUrl: rawUrl,
  supabaseAnonKey: rawKey,
  appName: import.meta.env.VITE_APP_NAME ?? 'ISPFlow',
  appUrl: import.meta.env.VITE_APP_URL ?? 'http://localhost:5173',

  /**
   * FastAPI provisioning backend (the provision engine).
   *
   * The provisioning screen talks to this service directly (bootstrap command,
   * device scan, workflow, live WebSocket logs). It is independent of the
   * Supabase project above: set `VITE_API_URL` to reach it.
   */
  apiUrl: (import.meta.env.VITE_API_URL ?? 'http://localhost:8000').replace(/\/+$/, ''),
  /**
   * Optional credentials used to sign in to the provisioning backend silently
   * (so the wizard works without a manual prompt). Both must be set together.
   */
  apiEmail: (import.meta.env.VITE_API_EMAIL ?? '').trim(),
  apiPassword: (import.meta.env.VITE_API_PASSWORD ?? '').trim(),
  /** Comma-separated list of emails auto-promoted to super admin (live mode). */
  superAdminEmails: (import.meta.env.VITE_SUPER_ADMIN_EMAILS ?? '')
    .split(',')
    .map((e: string) => e.trim().toLowerCase())
    .filter(Boolean),

  demo: {
    superAdminEmail: 'superadmin@ispflow.dev',
    superAdminPassword: 'Super@1234',
    ownerEmail: 'owner@ultrafaiba.co.ke',
    ownerPassword: 'Owner@1234',
  },
} as const

export type AppMode = 'live' | 'demo'