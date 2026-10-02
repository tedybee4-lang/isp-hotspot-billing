// =============================================================================
//  Ambient module declarations for URL imports.
//
//  The Edge runtime resolves `https://esm.sh/...` specifiers at runtime, but
//  Node's type checker cannot follow one. Without this file, any consumer whose
//  tsconfig reaches _shared — notably the Node worker — fails to typecheck
//  hashback-credentials.ts, even though nothing on the worker calls it.
//
//  Kept as a .d.ts rather than inside a source module on purpose: an ambient
//  declaration of a module that does not resolve must be a global script, or
//  TypeScript reads it as an augmentation and rejects the specifier.
//
//  Shape only. No runtime effect.
// =============================================================================

declare module 'https://esm.sh/@supabase/supabase-js@2' {
  export function createClient(
    url: string,
    key: string,
    options?: { auth?: { persistSession?: boolean; autoRefreshToken?: boolean } },
  ): unknown
}
