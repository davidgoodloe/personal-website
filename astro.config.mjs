import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  // Canonical site URL (used for absolute URLs / sitemaps).
  site: 'https://davidgoodloe.ai',
  // Emits /sitemap-index.xml + /sitemap-0.xml at build (referenced from robots.txt).
  integrations: [sitemap()],
});
