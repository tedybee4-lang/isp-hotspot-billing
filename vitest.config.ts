import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The frontend needs jsdom (localStorage-shaped demo store) and the worker
    // tests need plain Node. A per-file environment is the clean way to get
    // both without two configs.
    environment: 'jsdom',
    // Frontend tests live in src/.
    include: [
      'src/**/*.test.ts',
      'src/**/*.spec.ts',
      'src/**/*.test.tsx',
      'src/**/*.spec.tsx',
      // The Edge Function shared library is pure TypeScript with no Deno
      // imports, so the RouterOS protocol and compatibility rules are covered
      // by the same runner. This is how the hAP lite and CHR paths are tested
      // on a machine with no MikroTik hardware attached.
      'supabase/functions/_shared/**/*.{test,spec}.ts',
      'supabase/functions/**/*.{test,spec}.ts',
      // The VPS worker, which runs on Node rather than the browser. Included
      // here so one `npm test` proves the whole system, and so a broken worker
      // cannot be merged unnoticed.
      'worker/src/**/*.{test,spec}.ts',
    ],
    environmentMatchGlobs: [
      ['worker/**', 'node'],
      ['supabase/**', 'node'],
    ],
    globals: false,
  },
})