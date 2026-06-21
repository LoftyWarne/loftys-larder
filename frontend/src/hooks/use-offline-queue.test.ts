import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createInMemoryQueueStore } from '@/lib/offline-queue.ts';

import { useOfflineQueue } from './use-offline-queue.ts';

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    get: () => value,
  });
}

describe('useOfflineQueue', () => {
  beforeEach(() => {
    setOnline(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reflects the navigator.onLine flag on mount', async () => {
    setOnline(false);
    const store = createInMemoryQueueStore();
    const { result } = renderHook(() => useOfflineQueue({ planId: 1, store }));
    expect(result.current.isOnline).toBe(false);
    await act(async () => {
      await Promise.resolve();
    });
  });

  it('flips isOnline on online / offline window events', async () => {
    setOnline(true);
    const store = createInMemoryQueueStore();
    const { result } = renderHook(() => useOfflineQueue({ planId: 1, store }));
    expect(result.current.isOnline).toBe(true);

    await act(async () => {
      window.dispatchEvent(new Event('offline'));
      await Promise.resolve();
    });
    expect(result.current.isOnline).toBe(false);

    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await Promise.resolve();
    });
    expect(result.current.isOnline).toBe(true);
  });

  it('exposes queued ingredient ids scoped to the given planId', async () => {
    const store = createInMemoryQueueStore();
    await store.enqueue({ planId: 1, ingredientId: 10, isChecked: true });
    await store.enqueue({ planId: 1, ingredientId: 11, isChecked: false });
    await store.enqueue({ planId: 2, ingredientId: 99, isChecked: true });

    const { result } = renderHook(() => useOfflineQueue({ planId: 1, store }));

    await waitFor(() => {
      expect([...result.current.queuedIngredientIds]).toEqual(
        expect.arrayContaining([10, 11]),
      );
    });
    expect(result.current.queuedIngredientIds.has(99)).toBe(false);
    expect(result.current.queuedIngredientIds.size).toBe(2);
  });

  it('updates the queued set as the store changes', async () => {
    const store = createInMemoryQueueStore();
    const { result } = renderHook(() => useOfflineQueue({ planId: 1, store }));

    await act(async () => {
      await store.enqueue({ planId: 1, ingredientId: 10, isChecked: true });
    });
    await waitFor(() => {
      expect(result.current.queuedIngredientIds.has(10)).toBe(true);
    });

    await act(async () => {
      await store.remove(1, 10);
    });
    await waitFor(() => {
      expect(result.current.queuedIngredientIds.has(10)).toBe(false);
    });
  });

  it('cleans up window listeners and store subscription on unmount', async () => {
    const store = createInMemoryQueueStore();
    const subscribeSpy = vi.spyOn(store, 'subscribe');
    const { unmount } = renderHook(() => useOfflineQueue({ planId: 1, store }));
    const unsubscribe = subscribeSpy.mock.results[0]?.value as
      | (() => void)
      | undefined;
    expect(typeof unsubscribe).toBe('function');

    unmount();

    const listener = vi.fn();
    store.subscribe(listener);
    await store.enqueue({ planId: 1, ingredientId: 10, isChecked: true });
    expect(listener).toHaveBeenCalled();
  });
});
