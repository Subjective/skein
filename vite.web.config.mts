// The renderer alone in a browser, with a stand-in for the main process (src/renderer/src/dev/fakeApi.ts).
// For UI work and UI tests: `pnpm dev:web`.
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const d = import.meta.dirname;
export default defineConfig({
  root: resolve(d, 'src/renderer'),
  resolve: { alias: { '@shared': resolve(d, 'src/shared'), '@core': resolve(d, 'src/core'), '@': resolve(d, 'src/renderer/src') } },
  // the Browser tab's stand-in is an <iframe> here (the app uses a <webview>), so frames may load any web page
  plugins: [react(), { name: 'skein-web-frames', transformIndexHtml: html => html.replace("default-src 'self';", "default-src 'self'; frame-src 'self' http: https:;") }],
  server: { port: 5199 },
  build: { outDir: resolve(d, 'out/web'), emptyOutDir: true },
});
