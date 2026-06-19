import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useViewportTier } from './use-viewport-tier.ts';

const listeners: Record<string, (() => void)[]> = {};
const noop = (): void => undefined;

function buildMql(query: string, matches: boolean): MediaQueryList {
  return {
    matches,
    media: query,
    onchange: null,
    addEventListener: (_type: string, cb: () => void) => {
      const set = (listeners[query] ??= []);
      set.push(cb);
    },
    removeEventListener: (_type: string, cb: () => void) => {
      const set = listeners[query];
      if (!set) return;
      listeners[query] = set.filter((fn) => fn !== cb);
    },
    addListener: noop,
    removeListener: noop,
    dispatchEvent: () => false,
  } as unknown as MediaQueryList;
}

function setTier(tier: 'phone' | 'tablet' | 'desktop'): void {
  const md = tier !== 'phone';
  const lg = tier === 'desktop';
  window.matchMedia = (q: string): MediaQueryList => {
    if (q === '(min-width: 48rem)') return buildMql(q, md);
    if (q === '(min-width: 64rem)') return buildMql(q, lg);
    return buildMql(q, false);
  };
}

function fireChange(): void {
  for (const cbs of Object.values(listeners)) {
    for (const cb of cbs) cb();
  }
}

describe('useViewportTier', () => {
  beforeEach(() => {
    for (const k of Object.keys(listeners)) {
      listeners[k] = [];
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns desktop when both md and lg queries match', () => {
    setTier('desktop');
    const { result } = renderHook(() => useViewportTier());
    expect(result.current).toBe('desktop');
  });

  it('returns tablet when md matches but lg does not', () => {
    setTier('tablet');
    const { result } = renderHook(() => useViewportTier());
    expect(result.current).toBe('tablet');
  });

  it('returns phone when neither query matches', () => {
    setTier('phone');
    const { result } = renderHook(() => useViewportTier());
    expect(result.current).toBe('phone');
  });

  it('re-evaluates when matchMedia change events fire (rotation)', () => {
    setTier('phone');
    const { result } = renderHook(() => useViewportTier());
    expect(result.current).toBe('phone');

    act(() => {
      setTier('desktop');
      fireChange();
    });

    expect(result.current).toBe('desktop');
  });
});
