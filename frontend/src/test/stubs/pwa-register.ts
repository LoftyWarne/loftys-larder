// Test-only stub for the `virtual:pwa-register` module exposed by
// `vite-plugin-pwa` at build time. Vitest does not run the PWA plugin, so
// the virtual id can't be resolved — vitest.config.ts aliases the id to
// this file, and individual tests further `vi.mock` it to assert calls.
export function registerSW(): (reloadPage?: boolean) => Promise<void> {
  return () => Promise.resolve();
}
