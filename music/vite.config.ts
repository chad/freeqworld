import { defineConfig } from 'vite'

// Demo page for the chiptune engine. The engine itself is plain TS with no
// dependencies — import it directly from the world client (see src/web.ts).
export default defineConfig({
  base: './',
  server: { fs: { allow: ['..'] } }, // shared/src/hkdf.ts lives in ../fimp
  build: {
    outDir: 'dist',
    target: 'es2022',
    rollupOptions: { input: { index: 'index.html', studio: 'studio.html' } },
  },
})
