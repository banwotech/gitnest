import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ command }) => ({
  base: './',
  resolve: {
    alias: {
      'monaco-editor/codicon.css': fileURLToPath(new URL('./node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css', import.meta.url)),
    },
  },
  plugins: [react(), {
    name: 'development-csp',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => command === 'serve' ? html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") : html,
    },
  }],
  server: { host: '127.0.0.1', port: 5178, strictPort: true },
  build: { chunkSizeWarningLimit: 2500 },
}));
