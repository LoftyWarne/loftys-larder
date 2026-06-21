import { describe, expect, it, vi } from 'vitest';

import { drainOfflineQueue } from './offline-queue-drain.ts';
import { createInMemoryQueueStore } from './offline-queue.ts';

describe('drainOfflineQueue', () => {
  it('runs entries in queuedAt order and removes each on success', async () => {
    const store = createInMemoryQueueStore();
    await store.enqueue({
      planId: 1,
      ingredientId: 10,
      isChecked: true,
      queuedAt: 200,
    });
    await store.enqueue({
      planId: 1,
      ingredientId: 11,
      isChecked: false,
      queuedAt: 100,
    });

    const calls: number[] = [];
    const runner = vi.fn((input: { ingredientId: number }) => {
      calls.push(input.ingredientId);
      return Promise.resolve();
    });

    const result = await drainOfflineQueue(store, runner);

    expect(calls).toEqual([11, 10]);
    expect(result).toEqual({ drained: 2, remaining: 0 });
    expect(await store.list()).toEqual([]);
  });

  it('stops at first failure and keeps the failing entry plus rest', async () => {
    const store = createInMemoryQueueStore();
    await store.enqueue({
      planId: 1,
      ingredientId: 10,
      isChecked: true,
      queuedAt: 100,
    });
    await store.enqueue({
      planId: 1,
      ingredientId: 11,
      isChecked: true,
      queuedAt: 200,
    });
    await store.enqueue({
      planId: 1,
      ingredientId: 12,
      isChecked: true,
      queuedAt: 300,
    });

    const boom = new Error('network down');
    const runner = vi.fn((input: { ingredientId: number }) => {
      if (input.ingredientId === 11) return Promise.reject(boom);
      return Promise.resolve();
    });

    const result = await drainOfflineQueue(store, runner);

    expect(result).toEqual({ drained: 1, remaining: 2, error: boom });
    const remaining = await store.list();
    expect(remaining.map((e) => e.ingredientId)).toEqual([11, 12]);
  });

  it('is a no-op on an empty queue', async () => {
    const store = createInMemoryQueueStore();
    const runner = vi.fn();
    const result = await drainOfflineQueue(store, runner);
    expect(result).toEqual({ drained: 0, remaining: 0 });
    expect(runner).not.toHaveBeenCalled();
  });
});
