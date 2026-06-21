import type { ToggleShoppingItemCheckedInput } from '@loftys-larder/shared';

import {
  type OfflineQueueStore,
  type QueuedToggle,
  toMutationInput,
} from './offline-queue.ts';

// Drain the offline queue in `queuedAt` order. Each entry runs through the
// caller-supplied mutation runner — a thin wrapper around the existing tRPC
// client so the network path is unchanged from a live toggle. On any failure
// we stop and leave the failing entry (plus everything after it) in the queue
// for the next drain pass; the spec's "online event lies under captive
// portals" gotcha is the reason — we want partial progress, not an empty
// queue with mutations that never reached the server.

export interface DrainResult {
  drained: number;
  remaining: number;
  error?: unknown;
}

export type ToggleMutationRunner = (
  input: ToggleShoppingItemCheckedInput,
) => Promise<unknown>;

export async function drainOfflineQueue(
  store: OfflineQueueStore,
  runMutation: ToggleMutationRunner,
): Promise<DrainResult> {
  const entries = await store.list();
  if (entries.length === 0) return { drained: 0, remaining: 0 };

  let drained = 0;
  for (const entry of entries) {
    try {
      await runMutation(toMutationInput(entry));
    } catch (error) {
      return {
        drained,
        remaining: entries.length - drained,
        error,
      };
    }
    await store.remove(entry.planId, entry.ingredientId);
    drained += 1;
  }
  return { drained, remaining: 0 };
}

export type { QueuedToggle };
