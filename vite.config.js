import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

// Strict CSP only in the built app: the dev server's React preamble is an inline script (lesson L-node-ts-002).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: media:",
  "media-src 'self' media:",
  "font-src 'self' data:",
].join('; ');

/** Inject the Content-Security-Policy meta tag at build time only. */
function buildCsp() {
  return {
    name: 'build-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}">`);
    },
  };
}

export default defineConfig({
  root: `${here}src`,
  base: './',
  plugins: [react(), buildCsp()],
  server: { port: 5183, strictPort: true, fs: { allow: [here] } },
  build: { outDir: `${here}build/renderer`, emptyOutDir: true },
});
