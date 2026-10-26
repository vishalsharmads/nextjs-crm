import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

/** Serve the app under a sub-path (e.g. '/app') when it shares a domain with another site. */
const base = `/${(process.env.APP_BASE_PATH ?? '').replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    port: 5173,
    // Same-origin in dev too: the API is proxied, so auth cookies stay first-party.
    proxy: { '/api': { target: process.env.API_URL ?? 'http://localhost:4000', changeOrigin: false } },
    fs: { allow: ['../..'] },
  },
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Stable vendor chunks cache well across deploys.
        manualChunks: (id) => {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/](react|react-dom|scheduler|react-router)[\\/]/.test(id)) return 'react';
          if (/[\\/](@radix-ui|radix-ui|cmdk|sonner|vaul)[\\/]/.test(id)) return 'ui';
          if (/[\\/](zod|react-hook-form|@hookform)[\\/]/.test(id)) return 'forms';
          if (/[\\/](@tanstack)[\\/]/.test(id)) return 'tanstack';
          if (/[\\/](i18next|react-i18next)[\\/]/.test(id)) return 'i18n';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
