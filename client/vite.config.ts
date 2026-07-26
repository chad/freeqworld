import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  // Stamp the build so "is my browser running the deploy I just made?" is a
  // glance, not an inference. Surfaced on window.__build and in Dev mode.
  define: { __BUILD__: JSON.stringify(new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z') },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
})
