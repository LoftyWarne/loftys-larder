import { useEffect, useMemo, useState } from 'react';

import { useOnlineStatus } from '@/hooks/use-online-status.ts';
import {
  getOfflineQueueStore,
  type OfflineQueueStore,
  type QueuedToggle,
} from '@/lib/offline-queue.ts';

// Bridges the offline queue store + the online flag into React. The store
// is the singleton from `getOfflineQueueStore()` by default; tests inject an
// in-memory implementation. `navigator.onLine` can lie under captive portals,
// so the drain helper handles failures, but the flag is still useful to gate
// the initial drain on mount.

export interface UseOfflineQueueResult {
  store: OfflineQueueStore;
  entries: readonly QueuedToggle[];
  queuedIngredientIds: ReadonlySet<number>;
  isOnline: boolean;
}

export interface UseOfflineQueueOptions {
  planId: number;
  store?: OfflineQueueStore;
}

function sameEntries(
  a: readonly QueuedToggle[],
  b: readonly QueuedToggle[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (!left || !right) return false;
    if (
      left.planId !== right.planId ||
      left.ingredientId !== right.ingredientId ||
      left.isChecked !== right.isChecked ||
      left.queuedAt !== right.queuedAt
    ) {
      return false;
    }
  }
  return true;
}

export function useOfflineQueue({
  planId,
  store: injected,
}: UseOfflineQueueOptions): UseOfflineQueueResult {
  const store = useMemo(() => injected ?? getOfflineQueueStore(), [injected]);
  const [entries, setEntries] = useState<readonly QueuedToggle[]>([]);
  const isOnline = useOnlineStatus();

  useEffect(() => {
    let cancelled = false;
    function refresh(): void {
      void store.list().then((next) => {
        if (cancelled) return;
        setEntries((prev) => (sameEntries(prev, next) ? prev : next));
      });
    }
    refresh();
    const unsubscribe = store.subscribe(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [store]);

  const queuedIngredientIds = useMemo(() => {
    const ids = new Set<number>();
    for (const entry of entries) {
      if (entry.planId === planId) ids.add(entry.ingredientId);
    }
    return ids;
  }, [entries, planId]);

  return { store, entries, queuedIngredientIds, isOnline };
}
