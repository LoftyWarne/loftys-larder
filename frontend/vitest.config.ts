import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(here, './src'),
      '@loftys-larder/shared': path.resolve(here, '../shared/src/index.ts'),
      // vite-plugin-pwa exposes `virtual:pwa-register` only when its plugin
      // runs (i.e. in `vite build` / `vite dev`). Vitest does not load the
      // plugin, so alias the id to a stub the tests can `vi.mock`.
      'virtual:pwa-register': path.resolve(
        here,
        './src/test/stubs/pwa-register.ts',
      ),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
