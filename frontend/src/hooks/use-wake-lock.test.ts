import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWakeLock } from './use-wake-lock.ts';

interface FakeSentinel {
  released: boolean;
  release: ReturnType<typeof vi.fn>;
}

function fakeSentinel(): FakeSentinel {
  const sentinel: FakeSentinel = {
    released: false,
    release: vi.fn(() => {
      sentinel.released = true;
      return Promise.resolve();
    }),
  };
  return sentinel;
}

let visibility: DocumentVisibilityState = 'visible';

function setWakeLock(request: ReturnType<typeof vi.fn> | undefined): void {
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: request === undefined ? undefined : { request },
  });
}

function becomeVisible(): void {
  visibility = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'wakeLock');
});

describe('useWakeLock', () => {
  it('reads as unavailable where the API is missing', () => {
    setWakeLock(undefined);
    const { result } = renderHook(() => useWakeLock());
    expect(result.current).toBe('unavailable');
  });

  it('takes a screen lock on mount', async () => {
    const request = vi.fn(() => Promise.resolve(fakeSentinel()));
    setWakeLock(request);
    const { result } = renderHook(() => useWakeLock());

    await waitFor(() => {
      expect(result.current).toBe('held');
    });
    expect(request).toHaveBeenCalledWith('screen');
  });

  it('reads as unavailable when the request is refused', async () => {
    setWakeLock(vi.fn(() => Promise.reject(new Error('NotAllowedError'))));
    const { result } = renderHook(() => useWakeLock());

    await waitFor(() => {
      expect(result.current).toBe('unavailable');
    });
  });

  it('takes the lock again when the page becomes visible after the browser dropped it', async () => {
    const first = fakeSentinel();
    const request = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(fakeSentinel());
    setWakeLock(request);
    const { result } = renderHook(() => useWakeLock());
    await waitFor(() => {
      expect(result.current).toBe('held');
    });

    visibility = 'hidden';
    first.released = true;
    act(() => {
      becomeVisible();
    });

    await waitFor(() => {
      expect(request).toHaveBeenCalledTimes(2);
    });
  });

  it('does not ask again while the lock is still held', async () => {
    const request = vi.fn(() => Promise.resolve(fakeSentinel()));
    setWakeLock(request);
    const { result } = renderHook(() => useWakeLock());
    await waitFor(() => {
      expect(result.current).toBe('held');
    });

    act(() => {
      becomeVisible();
    });

    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not ask while the page is hidden', () => {
    visibility = 'hidden';
    const request = vi.fn(() => Promise.resolve(fakeSentinel()));
    setWakeLock(request);
    renderHook(() => useWakeLock());
    expect(request).not.toHaveBeenCalled();
  });

  it('lets the lock go on unmount', async () => {
    const sentinel = fakeSentinel();
    setWakeLock(vi.fn(() => Promise.resolve(sentinel)));
    const { result, unmount } = renderHook(() => useWakeLock());
    await waitFor(() => {
      expect(result.current).toBe('held');
    });

    unmount();

    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });

  it('lets go of a lock that arrives after unmount', async () => {
    const sentinel = fakeSentinel();
    let resolve: (value: FakeSentinel) => void = () => undefined;
    setWakeLock(
      vi.fn(
        () =>
          new Promise<FakeSentinel>((r) => {
            resolve = r;
          }),
      ),
    );
    const { unmount } = renderHook(() => useWakeLock());

    unmount();
    resolve(sentinel);

    await waitFor(() => {
      expect(sentinel.release).toHaveBeenCalledTimes(1);
    });
  });
});
