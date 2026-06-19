import '@testing-library/jest-dom/vitest';

// jsdom omits window.matchMedia, which the viewport-tier hook depends on
// for the planner's responsive interaction tiers (FEAT-40). Tests that need
// to simulate a specific tier reassign window.matchMedia themselves; this
// default matches nothing (so tier resolves to 'phone').
const noop = (): void => undefined;
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList => {
    const mql: Partial<MediaQueryList> = {
      matches: false,
      media: query,
      onchange: null,
      addEventListener: noop,
      removeEventListener: noop,
      addListener: noop,
      removeListener: noop,
      dispatchEvent: () => false,
    };
    return mql as MediaQueryList;
  };
}
