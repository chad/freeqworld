import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'shared/src/**/*.test.ts',
      'server/src/**/*.test.ts',
      'client/src/**/*.test.ts',
      'pfp/src/**/*.test.ts',
      'music/src/**/*.test.ts',
    ],
    environment: 'node',
    // Several suites do real work — minting a theme composes and renders audio,
    // and the share tests resolve a real profile. They were passing on 5s only
    // because the suite was smaller; adding the score exports tipped them over,
    // which shows up as tests that pass alone and fail in the full run.
    testTimeout: 20_000,
  },
})
