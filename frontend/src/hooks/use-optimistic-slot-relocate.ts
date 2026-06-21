import type { GetPlanResult, PlanSlot } from '@loftys-larder/shared';

import { trpc } from '@/lib/trpc.ts';

// Sibling of `useOptimisticSlotUpdate` for the slot ↔ slot drag (FEAT-40).
// Patches *two* slots in the plans.get cache atomically so the planner UI
// never observes the swap mid-flight. Reconciles from the server response on
// settle, last-write-wins per DEC-36 — no invalidation.
//
// Behaviour mirrors the single-slot hook:
//   - `onMutate` snapshots the whole plan (so rollback restores both slots
//     together) and applies a paired patch.
//   - `onError` restores the snapshot in one setQueryData.
//   - `onSettled` swaps the two server-returned rows into cache.

export interface OptimisticSlotRelocateOptions {
  planId: number;
  onError?: (error: unknown) => void;
}

export interface RelocateArgs {
  sourceSlotId: number;
  destSlotId: number;
}

export interface UseOptimisticSlotRelocateResult {
  relocate: (args: RelocateArgs) => void;
  isPending: boolean;
}

export function useOptimisticSlotRelocate({
  planId,
  onError,
}: OptimisticSlotRelocateOptions): UseOptimisticSlotRelocateResult {
  const utils = trpc.useUtils();

  const mutation = trpc.slots.relocate.useMutation({
    onMutate: async (input) => {
      await utils.plans.get.cancel({ id: planId });
      const previous = utils.plans.get.getData({ id: planId });
      if (!previous) {
        return { previous: undefined };
      }
      const source = previous.slots.find((s) => s.id === input.sourceSlotId);
      const dest = previous.slots.find((s) => s.id === input.destSlotId);
      if (!source || !dest) {
        return { previous };
      }
      const patched = applyRelocatePatch(previous, source, dest);
      utils.plans.get.setData({ id: planId }, patched);
      return { previous };
    },
    onError: (err, _input, ctx) => {
      if (ctx?.previous) {
        utils.plans.get.setData({ id: planId }, ctx.previous);
      }
      onError?.(err);
    },
    onSettled: (data) => {
      // Relocate moves slot payload between dates so per-day plant-point
      // totals can shift on either end; invalidate both granularities of
      // plants.* to force a refetch (FEAT-41).
      void utils.plants.forDay.invalidate({ planId });
      void utils.plants.forPlan.invalidate({ planId });
      if (!data) return;
      const current = utils.plans.get.getData({ id: planId });
      if (!current) return;
      utils.plans.get.setData(
        { id: planId },
        replaceSlots(current, [data.sourceSlot, data.destSlot]),
      );
    },
  });

  return {
    relocate: (args) => {
      mutation.mutate(args);
    },
    isPending: mutation.isPending,
  };
}

// Dest receives source's full content, source receives dest's content; when
// dest was empty the source ends up empty after the swap. Slot identity
// (`id`, `planId`, `date`, `occasionId`, `occasionName`) stays put — only
// the editable payload moves between rows.
function applyRelocatePatch(
  plan: GetPlanResult,
  source: PlanSlot,
  dest: PlanSlot,
): GetPlanResult {
  const patchedSource = withSlotPayload(source, dest);
  const patchedDest = withSlotPayload(dest, source);
  return {
    ...plan,
    slots: plan.slots.map((slot) => {
      if (slot.id === source.id) return patchedSource;
      if (slot.id === dest.id) return patchedDest;
      return slot;
    }),
  };
}

function withSlotPayload(target: PlanSlot, fromSlot: PlanSlot): PlanSlot {
  return {
    ...target,
    slotType: fromSlot.slotType,
    recipeId: fromSlot.recipeId,
    numberOfServings: fromSlot.numberOfServings,
    chefUserId: fromSlot.chefUserId,
    cooksBaseRecipeId: fromSlot.cooksBaseRecipeId,
    cooksBaseServings: fromSlot.cooksBaseServings,
    comment: fromSlot.comment,
    recipe: fromSlot.recipe,
    cooksBaseRecipe: fromSlot.cooksBaseRecipe,
    pairedRecipe: fromSlot.pairedRecipe,
  };
}

function replaceSlots(
  plan: GetPlanResult,
  serverSlots: PlanSlot[],
): GetPlanResult {
  const byId = new Map(serverSlots.map((s) => [s.id, s] as const));
  return {
    ...plan,
    slots: plan.slots.map((slot) => byId.get(slot.id) ?? slot),
  };
}
