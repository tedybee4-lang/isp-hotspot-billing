import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  // Paths in this config are resolved from worker/, but the repo's own vitest
  // config lives one level up, so the root is pinned explicitly.
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    // The worker is plain Node, so it does not want the jsdom the frontend needs.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
})