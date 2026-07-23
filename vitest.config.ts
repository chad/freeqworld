import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['shared/src/**/*.test.ts', 'server/src/**/*.test.ts', 'client/src/**/*.test.ts', 'pfp/src/**/*.test.ts'],
    environment: 'node',
  },
})
