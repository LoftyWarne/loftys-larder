import { useCallback, useSyncExternalStore } from 'react';

// The planner gates on two breakpoints. At `lg` (1024 px) and wider the Recipe
// Bank renders alongside the grid and bank → slot drag is live (FEAT-40,
// DEC-84 / DEC-85); slot ↔ slot drag works at every width. Below `md`
// (768 px) the grid gives way to one card per day (FEAT-72, DEC-115).

const LG_QUERY = '(min-width: 64rem)';
const MD_QUERY = '(min-width: 48rem)';

const noop = (): void => undefined;

function useMinWidth(query: string): boolean {
  const subscribe = useCallback(
    (callback: () => void) => {
      if (typeof window === 'undefined') return noop;
      const mql = window.matchMedia(query);
      mql.addEventListener('change', callback);
      return () => {
        mql.removeEventListener('change', callback);
      };
    },
    [query],
  );
  const getSnapshot = useCallback(
    () =>
      typeof window === 'undefined' ? false : window.matchMedia(query).matches,
    [query],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export function useIsLargeViewport(): boolean {
  return useMinWidth(LG_QUERY);
}

export function useIsMediumViewport(): boolean {
  return useMinWidth(MD_QUERY);
}
