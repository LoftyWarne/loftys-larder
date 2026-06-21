import type { ToggleShoppingItemCheckedInput } from '@loftys-larder/shared';

// Offline queue for `shopping.toggleChecked` mutations that fail because the
// browser is offline. Collapses on `(planId, ingredientId)` so check → uncheck
// → check on one line never grows the queue past O(lines). On reconnect the
// drain helper replays entries in `queuedAt` ascending order — LWW (DEC-36)
// means the most recently queued state for a line is what lands on the server.
//
// The store is split into an interface so the React hook can be unit-tested
// against an in-memory implementation. IndexedDB is the runtime choice
// (cookies/localStorage are too small and synchronous); when IDB is absent
// (SSR, exotic embedded contexts) we fall back to the in-memory store so the
// app continues to work — losing the queue on reload is the accepted v1 risk
// per the plan's LWW posture.

export interface QueuedToggle {
  planId: number;
  ingredientId: number;
  isChecked: boolean;
  queuedAt: number;
}

export type QueuedToggleInput = Omit<QueuedToggle, 'queuedAt'> &
  Partial<Pick<QueuedToggle, 'queuedAt'>>;

export interface OfflineQueueStore {
  enqueue(entry: QueuedToggleInput): Promise<void>;
  list(): Promise<QueuedToggle[]>;
  remove(planId: number, ingredientId: number): Promise<void>;
  clear(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export function entryKey(planId: number, ingredientId: number): string {
  return `${String(planId)}:${String(ingredientId)}`;
}

export function toMutationInput(
  entry: QueuedToggle,
): ToggleShoppingItemCheckedInput {
  return {
    planId: entry.planId,
    ingredientId: entry.ingredientId,
    isChecked: entry.isChecked,
  };
}

function byQueuedAtAsc(a: QueuedToggle, b: QueuedToggle): number {
  return a.queuedAt - b.queuedAt;
}

export function createInMemoryQueueStore(): OfflineQueueStore {
  const entries = new Map<string, QueuedToggle>();
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  return {
    async enqueue(input) {
      const queuedAt = input.queuedAt ?? Date.now();
      entries.set(entryKey(input.planId, input.ingredientId), {
        planId: input.planId,
        ingredientId: input.ingredientId,
        isChecked: input.isChecked,
        queuedAt,
      });
      notify();
      await Promise.resolve();
    },
    async list() {
      await Promise.resolve();
      return [...entries.values()].sort(byQueuedAtAsc);
    },
    async remove(planId, ingredientId) {
      const existed = entries.delete(entryKey(planId, ingredientId));
      if (existed) notify();
      await Promise.resolve();
    },
    async clear() {
      const hadEntries = entries.size > 0;
      entries.clear();
      if (hadEntries) notify();
      await Promise.resolve();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const DB_NAME = 'loftys-larder-offline-queue';
const DB_VERSION = 1;
const STORE_NAME = 'shopping-toggles';

function openDB(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = idb.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('Failed to open offline queue DB'));
    };
  });
}

interface StoredRecord extends QueuedToggle {
  key: string;
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'));
    };
  });
}

export function createIndexedDBQueueStore(idb: IDBFactory): OfflineQueueStore {
  const dbPromise = openDB(idb);
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  async function withStore<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    const db = await dbPromise;
    const tx = db.transaction(STORE_NAME, mode);
    const result = await fn(tx.objectStore(STORE_NAME));
    return new Promise<T>((resolve, reject) => {
      tx.oncomplete = () => {
        resolve(result);
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error('IndexedDB transaction failed'));
      };
      tx.onabort = () => {
        reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      };
    });
  }

  return {
    async enqueue(input) {
      const queuedAt = input.queuedAt ?? Date.now();
      const record: StoredRecord = {
        key: entryKey(input.planId, input.ingredientId),
        planId: input.planId,
        ingredientId: input.ingredientId,
        isChecked: input.isChecked,
        queuedAt,
      };
      await withStore('readwrite', async (store) => {
        await promisifyRequest(store.put(record));
      });
      notify();
    },
    async list() {
      const records = await withStore('readonly', async (store) => {
        return promisifyRequest(store.getAll() as IDBRequest<StoredRecord[]>);
      });
      return records
        .map(({ planId, ingredientId, isChecked, queuedAt }) => ({
          planId,
          ingredientId,
          isChecked,
          queuedAt,
        }))
        .sort(byQueuedAtAsc);
    },
    async remove(planId, ingredientId) {
      await withStore('readwrite', async (store) => {
        await promisifyRequest(store.delete(entryKey(planId, ingredientId)));
      });
      notify();
    },
    async clear() {
      await withStore('readwrite', async (store) => {
        await promisifyRequest(store.clear());
      });
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

let sharedStore: OfflineQueueStore | null = null;

export function getOfflineQueueStore(): OfflineQueueStore {
  if (sharedStore) return sharedStore;
  const idb =
    typeof globalThis !== 'undefined' && 'indexedDB' in globalThis
      ? (globalThis as { indexedDB?: IDBFactory }).indexedDB
      : undefined;
  sharedStore = idb
    ? createIndexedDBQueueStore(idb)
    : createInMemoryQueueStore();
  return sharedStore;
}

export function __resetOfflineQueueStoreForTests(
  store: OfflineQueueStore | null = null,
): void {
  sharedStore = store;
}
