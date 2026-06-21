import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetOfflineQueueStoreForTests,
  createInMemoryQueueStore,
  entryKey,
  getOfflineQueueStore,
  toMutationInput,
} from './offline-queue.ts';

beforeEach(() => {
  __resetOfflineQueueStoreForTests(null);
});

describe('createInMemoryQueueStore', () => {
  it('enqueues distinct entries and lists them in queuedAt order', async () => {
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
      isChecked: true,
      queuedAt: 100,
    });

    const entries = await store.list();
    expect(entries.map((e) => e.ingredientId)).toEqual([11, 10]);
  });

  it('collapses on (planId, ingredientId): later enqueue replaces state and queuedAt', async () => {
    const store = createInMemoryQueueStore();
    await store.enqueue({
      planId: 2,
      ingredientId: 5,
      isChecked: true,
      queuedAt: 100,
    });
    await store.enqueue({
      planId: 2,
      ingredientId: 5,
      isChecked: false,
      queuedAt: 250,
    });

    const entries = await store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      planId: 2,
      ingredientId: 5,
      isChecked: false,
      queuedAt: 250,
    });
  });

  it('treats same ingredientId across plans as separate entries', async () => {
    const store = createInMemoryQueueStore();
    await store.enqueue({ planId: 1, ingredientId: 5, isChecked: true });
    await store.enqueue({ planId: 2, ingredientId: 5, isChecked: false });

    const entries = await store.list();
    expect(entries).toHaveLength(2);
  });

  it('remove deletes only the targeted entry', async () => {
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

    await store.remove(1, 10);

    const entries = await store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.ingredientId).toBe(11);
  });

  it('clear empties the store', async () => {
    const store = createInMemoryQueueStore();
    await store.enqueue({ planId: 1, ingredientId: 10, isChecked: true });
    await store.enqueue({ planId: 1, ingredientId: 11, isChecked: true });
    await store.clear();
    expect(await store.list()).toEqual([]);
  });

  it('subscribe fires on enqueue and remove and stops after unsubscribe', async () => {
    const store = createInMemoryQueueStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    await store.enqueue({ planId: 1, ingredientId: 10, isChecked: true });
    expect(listener).toHaveBeenCalledTimes(1);

    await store.remove(1, 10);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    await store.enqueue({ planId: 1, ingredientId: 11, isChecked: true });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('remove on a missing entry does not notify subscribers', async () => {
    const store = createInMemoryQueueStore();
    const listener = vi.fn();
    store.subscribe(listener);

    await store.remove(1, 999);
    expect(listener).not.toHaveBeenCalled();
  });

  it('defaults queuedAt to Date.now() when omitted', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-21T10:00:00Z'));
      const store = createInMemoryQueueStore();
      await store.enqueue({ planId: 1, ingredientId: 10, isChecked: true });
      const [entry] = await store.list();
      expect(entry?.queuedAt).toBe(Date.now());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('helpers', () => {
  it('entryKey composes a stable string', () => {
    expect(entryKey(3, 7)).toBe('3:7');
  });

  it('toMutationInput strips queuedAt to leave the toggle input shape', () => {
    expect(
      toMutationInput({
        planId: 1,
        ingredientId: 10,
        isChecked: true,
        queuedAt: 123,
      }),
    ).toEqual({ planId: 1, ingredientId: 10, isChecked: true });
  });
});

describe('getOfflineQueueStore', () => {
  it('returns a working in-memory store when indexedDB is unavailable', async () => {
    const original = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    Reflect.deleteProperty(globalThis, 'indexedDB');
    try {
      const store = getOfflineQueueStore();
      await store.enqueue({ planId: 1, ingredientId: 10, isChecked: true });
      expect((await store.list())[0]).toMatchObject({ ingredientId: 10 });
      expect(getOfflineQueueStore()).toBe(store);
    } finally {
      if (original !== undefined) {
        (globalThis as { indexedDB?: IDBFactory }).indexedDB = original;
      }
    }
  });
});
