import { useSyncExternalStore } from 'react';

// Three planner interaction tiers gated on viewport width. The planner page
// hides the Recipe Bank below `md` and mounts the DnD context at `lg+`; both
// observers read this hook so the breakpoints stay defined in one place.
export type ViewportTier = 'phone' | 'tablet' | 'desktop';

// Tailwind: md = 48rem (768px), lg = 64rem (1024px).
const MD_QUERY = '(min-width: 48rem)';
const LG_QUERY = '(min-width: 64rem)';

function getTier(): ViewportTier {
  if (typeof window === 'undefined') return 'phone';
  if (window.matchMedia(LG_QUERY).matches) return 'desktop';
  if (window.matchMedia(MD_QUERY).matches) return 'tablet';
  return 'phone';
}

const noop = (): void => undefined;

function subscribe(callback: () => void): () => void {
  if (typeof window === 'undefined') return noop;
  const md = window.matchMedia(MD_QUERY);
  const lg = window.matchMedia(LG_QUERY);
  md.addEventListener('change', callback);
  lg.addEventListener('change', callback);
  return () => {
    md.removeEventListener('change', callback);
    lg.removeEventListener('change', callback);
  };
}

export function useViewportTier(): ViewportTier {
  return useSyncExternalStore(subscribe, getTier, () => 'phone');
}
