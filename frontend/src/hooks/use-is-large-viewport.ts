import { useSyncExternalStore } from 'react';

// FEAT-40 — the planner has two interaction shapes gated on a single
// breakpoint. At `lg` (1024 px) and wider, the Recipe Bank renders alongside
// the grid and `@dnd-kit/core` mounts for click-to-assign + drag-and-drop.
// Below `lg`, the bank is hidden and slot assignment routes exclusively
// through the editor sheet (no drag affordances anywhere). The two were
// originally separate decisions but the layout-coupling makes one boolean
// the cleanest expression.

const LG_QUERY = '(min-width: 64rem)';

const noop = (): void => undefined;

function getSnapshot(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia(LG_QUERY).matches;
}

function subscribe(callback: () => void): () => void {
  if (typeof window === 'undefined') return noop;
  const mql = window.matchMedia(LG_QUERY);
  mql.addEventListener('change', callback);
  return () => {
    mql.removeEventListener('change', callback);
  };
}

export function useIsLargeViewport(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
