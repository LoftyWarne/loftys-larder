import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useIsLargeViewport } from './use-is-large-viewport.ts';

const listeners: (() => void)[] = [];
const noop = (): void => undefined;

function buildMql(query: string, matches: boolean): MediaQueryList {
  return {
    matches,
    media: query,
    onchange: null,
    addEventListener: (_type: string, cb: () => void) => {
      listeners.push(cb);
    },
    removeEventListener: (_type: string, cb: () => void) => {
      const index = listeners.indexOf(cb);
      if (index >= 0) listeners.splice(index, 1);
    },
    addListener: noop,
    removeListener: noop,
    dispatchEvent: () => false,
  } as unknown as MediaQueryList;
}

function setLarge(isLarge: boolean): void {
  window.matchMedia = (q: string): MediaQueryList => buildMql(q, isLarge);
}

function fireChange(): void {
  for (const cb of [...listeners]) cb();
}

describe('useIsLargeViewport', () => {
  beforeEach(() => {
    listeners.length = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when the lg query matches', () => {
    setLarge(true);
    const { result } = renderHook(() => useIsLargeViewport());
    expect(result.current).toBe(true);
  });

  it('returns false when the lg query does not match', () => {
    setLarge(false);
    const { result } = renderHook(() => useIsLargeViewport());
    expect(result.current).toBe(false);
  });

  it('re-evaluates when matchMedia change events fire (rotation)', () => {
    setLarge(false);
    const { result } = renderHook(() => useIsLargeViewport());
    expect(result.current).toBe(false);

    act(() => {
      setLarge(true);
      fireChange();
    });

    expect(result.current).toBe(true);
  });
});
