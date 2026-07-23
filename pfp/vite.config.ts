import { defineConfig } from 'vite'

// Served at freeqworld.boxd.sh/id (same origin as the world client, so the
// broker's compiled-in return_to allowlist needs no change — see
// docs/PFP-APP-PLAN.md). Absolute base so built assets resolve under /id/.
export default defineConfig({
  base: '/id/',
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
})
