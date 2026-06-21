import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { pwaManifest, pwaRuntimeCaching } from './src/lib/pwa-config.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

const BACKEND_DEV_URL = process.env.BACKEND_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
      routeFileIgnorePattern: '\\.test\\.tsx?$',
    }),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: null,
      // Dev-mode SW + Vite HMR is a known footgun (FEAT-42 common gotcha).
      devOptions: { enabled: false },
      includeAssets: ['icons/apple-touch-icon.png'],
      manifest: pwaManifest,
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: pwaRuntimeCaching,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(here, './src'),
      '@loftys-larder/shared': path.resolve(here, '../shared/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: BACKEND_DEV_URL,
        changeOrigin: true,
      },
    },
  },
});
