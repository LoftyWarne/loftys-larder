// SW registration gated to production builds. Dev keeps Vite HMR clean —
// a stale SW shadowing HMR is one of the FEAT-42 common-gotcha hazards.

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }
  // Dynamic import keeps the virtual module out of dev/test bundles, where
  // `virtual:pwa-register` does not resolve.
  // Best-effort: if the chunk fetch fails (offline mid-boot, a preview
  // renderer tearing the page down), the next page load retries. Left
  // uncaught it surfaces in Sentry as an unhandled rejection.
  import('virtual:pwa-register')
    .then(({ registerSW }) => {
      registerSW({ immediate: true });
    })
    .catch(() => undefined);
}
