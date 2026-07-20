import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  // tests share two live town servers; run serially to keep world state simple
  workers: 1,
  use: {
    baseURL: 'http://localhost:8787',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx vite build client && FIMP_START=1 npx vite-node server/src/main.ts',
    url: 'http://localhost:8787/api/town',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
