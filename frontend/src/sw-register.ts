// SW registration gated to production builds. Dev keeps Vite HMR clean —
// a stale SW shadowing HMR is one of the FEAT-42 common-gotcha hazards.

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }
  // Dynamic import keeps the virtual module out of dev/test bundles, where
  // `virtual:pwa-register` does not resolve.
  void import('virtual:pwa-register').then(({ registerSW }) => {
    registerSW({ immediate: true });
  });
}
