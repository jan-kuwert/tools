import { defineConfig } from 'astro/config';

// SITE and BASE are deployment-specific; see README "Open decisions".
const base = process.env.BASE ?? '/tools';

export default defineConfig({
  site: process.env.SITE ?? 'https://example.com',
  base,
  // Nest output under the base so the publish dir maps 1:1 to URLs on Netlify.
  outDir: `./dist${base}`,
  trailingSlash: 'always',
  build: { format: 'directory' },
  // No inline scripts: CSP forbids them.
  vite: { build: { assetsInlineLimit: 0 } },
});
