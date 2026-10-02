import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The demo backend is browser-shaped (localStorage), so jsdom is required.
    environment: 'jsdom',
    // e2e/ belongs to Playwright — see playwright.config.ts.
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    globals: false,
  },
})