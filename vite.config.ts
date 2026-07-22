import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Deploy channel: "prod" (site root, built from the latest release tag) or
// "staging" (/staging/ subpath, built from main). The deploy workflow sets
// STAMP_CHANNEL per build; local builds default to prod.
const channel = process.env.STAMP_CHANNEL === 'staging' ? 'staging' : 'prod';

export default defineConfig({
  // Relative base so the built app works both at the site root and under the
  // /staging/ subpath from a single GitHub Pages deploy.
  base: './',
  plugins: [preact()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_CHANNEL__: JSON.stringify(channel),
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
  },
});
