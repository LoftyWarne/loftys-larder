import { describe, expect, it } from 'vitest';
import {
  SHOPPING_LIST_NETWORK_FIRST_PATTERN,
  pwaManifest,
  pwaRuntimeCaching,
} from '../lib/pwa-config.ts';

describe('PWA web manifest', () => {
  it('declares the canonical app identity', () => {
    expect(pwaManifest.name).toBe("Lofty's Larder");
    expect(pwaManifest.short_name).toBe('Larder');
  });

  it('uses an absolute start_url and matching scope so SW caching is unambiguous', () => {
    expect(pwaManifest.start_url).toBe('/');
    expect(pwaManifest.scope).toBe('/');
  });

  it('runs in standalone display mode for installed PWAs', () => {
    expect(pwaManifest.display).toBe('standalone');
  });

  it('sets theme + background colours so the install splash does not flash', () => {
    expect(pwaManifest.theme_color).toMatch(/^#[0-9a-fA-F]{3,8}$/);
    expect(pwaManifest.background_color).toMatch(/^#[0-9a-fA-F]{3,8}$/);
  });

  it('lists 192 + 512 + maskable icons', () => {
    const icons = pwaManifest.icons ?? [];
    const sizes = icons.map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });
});

describe('PWA runtime caching for the shopping list', () => {
  it('matches the tRPC procedure segment, not the batch=1 query string', () => {
    // tRPC URL shape (cross-cutting #16): /api/trpc/<procedure>?batch=1&input=...
    const batched = '/api/trpc/shopping.getForPlan?batch=1&input=%7B%7D';
    const unbatched = '/api/trpc/shopping.getForPlan';
    expect(SHOPPING_LIST_NETWORK_FIRST_PATTERN.test(batched)).toBe(true);
    expect(SHOPPING_LIST_NETWORK_FIRST_PATTERN.test(unbatched)).toBe(true);
  });

  it('does not over-match to other shopping procedures or other namespaces', () => {
    // If FEAT-43 ships shopping.toggleChecked as a write, we don't want
    // the network-first rule capturing it.
    expect(
      SHOPPING_LIST_NETWORK_FIRST_PATTERN.test(
        '/api/trpc/shopping.toggleChecked',
      ),
    ).toBe(false);
    expect(
      SHOPPING_LIST_NETWORK_FIRST_PATTERN.test('/api/trpc/recipes.list'),
    ).toBe(false);
    expect(SHOPPING_LIST_NETWORK_FIRST_PATTERN.test('/api/auth/session')).toBe(
      false,
    );
  });

  it('configures NetworkFirst with a finite timeout so a stalled network falls back to cache', () => {
    const rule = pwaRuntimeCaching.find(
      (r) => r.urlPattern === SHOPPING_LIST_NETWORK_FIRST_PATTERN,
    );
    expect(rule).toBeDefined();
    expect(rule?.handler).toBe('NetworkFirst');
    expect(rule?.options?.networkTimeoutSeconds).toBeGreaterThan(0);
    expect(rule?.options?.networkTimeoutSeconds).toBeLessThanOrEqual(10);
  });

  it('uses a named cache bucket so it can be inspected or evicted independently', () => {
    const rule = pwaRuntimeCaching.find(
      (r) => r.urlPattern === SHOPPING_LIST_NETWORK_FIRST_PATTERN,
    );
    expect(rule?.options?.cacheName).toBe('shopping-list-network-first');
  });
});
