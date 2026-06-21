// PWA config consumed by `vite-plugin-pwa` in vite.config.ts.
// Extracted so unit tests can assert manifest shape + runtime caching
// without invoking a full `vite build`.

import type { ManifestOptions } from 'vite-plugin-pwa';

// vite-plugin-pwa does not re-export `RuntimeCaching` and we don't take a
// dev-dep on `workbox-build` for one type. The structural shape below is
// the subset the plugin reads (matches workbox-build@7's `RuntimeCaching`).
type RuntimeCachingHandler =
  | 'NetworkFirst'
  | 'NetworkOnly'
  | 'CacheFirst'
  | 'CacheOnly'
  | 'StaleWhileRevalidate';

interface RuntimeCachingRule {
  urlPattern: RegExp | string;
  handler: RuntimeCachingHandler;
  options?: {
    cacheName?: string;
    networkTimeoutSeconds?: number;
    expiration?: { maxEntries?: number; maxAgeSeconds?: number };
    cacheableResponse?: { statuses?: number[] };
  };
}

export const pwaManifest: Partial<ManifestOptions> = {
  name: "Lofty's Larder",
  short_name: 'Larder',
  description: 'Meal planning, recipes, and shopping lists for the household.',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  theme_color: '#ffffff',
  background_color: '#ffffff',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    {
      src: '/icons/icon-maskable-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    },
  ],
};

// tRPC URL shape (cross-cutting #16) is `/api/trpc/<procedure>?batch=1&input=...`.
// The match runs against the URL string before the query is stripped, so a
// non-anchored substring match on the procedure segment is the right shape.
export const SHOPPING_LIST_NETWORK_FIRST_PATTERN =
  /\/api\/trpc\/shopping\.getForPlan/;

export const pwaRuntimeCaching: RuntimeCachingRule[] = [
  {
    urlPattern: SHOPPING_LIST_NETWORK_FIRST_PATTERN,
    handler: 'NetworkFirst',
    options: {
      cacheName: 'shopping-list-network-first',
      networkTimeoutSeconds: 3,
      expiration: {
        maxEntries: 32,
        maxAgeSeconds: 60 * 60 * 24 * 7,
      },
      cacheableResponse: { statuses: [0, 200] },
    },
  },
];
