import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The SPA is built to static files in dist/ and served by the bff on its own origin, so the browser
// has one origin, one cookie and no CORS. In `npm run dev -w @aisdlc/web` the API calls go to a bff
// on 8340 through the dev proxy (same-origin from the browser's point of view).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // No inline scripts or styles: the bff's policy is default-src 'self'.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
  server: {
    proxy: { '/api': 'http://localhost:8340', '/auth': 'http://localhost:8340' },
  },
});
