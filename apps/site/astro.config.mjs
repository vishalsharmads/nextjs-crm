import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Public marketing site. Static output: deploy `dist/` to the marketing domain behind nginx.
export default defineConfig({
  site: process.env.SITE_URL ?? 'https://bespoq.example',
  output: 'static',
  trailingSlash: 'never',
  build: { format: 'file' },
  integrations: [sitemap()],
  devToolbar: { enabled: false },
});
