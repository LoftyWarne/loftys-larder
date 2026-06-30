import type {
  PlanSlot,
  PlanSlotItem,
  RecipeListItem,
  UpdateSlotInput,
} from '@loftys-larder/shared';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';

import { DndProvider } from '@/components/planner/dnd-provider.tsx';
import { PlannerGrid } from '@/components/planner/planner-grid.tsx';
import { PlantPointsBadge } from '@/components/planner/plant-points-badge.tsx';
import { RecipeBank } from '@/components/planner/recipe-bank.tsx';
import { SlotEditorSheet } from '@/components/planner/slot-editor-sheet.tsx';
import { Button } from '@/components/ui/button.tsx';
import { useDayPlantPoints } from '@/hooks/use-day-plant-points.ts';
import { useIsLargeViewport } from '@/hooks/use-is-large-viewport.ts';
import { useOptimisticSlotRelocate } from '@/hooks/use-optimistic-slot-relocate.ts';
import { useOptimisticSlotUpdate } from '@/hooks/use-optimistic-slot-update.ts';
import { deriveBaseBalances } from '@/lib/serving-variation-supply.ts';
import {
  clampRange,
  eachDateInRange,
  formatDayRangeLabel,
} from '@/lib/date-utils.ts';
import { trpc } from '@/lib/trpc.ts';

export function PlannerPage(): React.ReactElement {
  const params = useParams({ from: '/_authed/plans/$planId' });
  const search = useSearch({ from: '/_authed/plans/$planId' });
  const planId = Number.parseInt(params.planId, 10);
  const idIsValid = Number.isInteger(planId) && planId > 0;

  // FEAT-40 — the bank and DnD travel together. At `lg+` the bank renders
  // alongside the grid and dnd-kit mounts; below `lg` the bank is hidden and
  // slot assignment routes through the editor sheet only.
  const isLargeViewport = useIsLargeViewport();

  const planQuery = trpc.plans.get.useQuery(
    { id: planId },
    { enabled: idIsValid },
  );
  const membersQuery = trpc.user.listHouseholdMembers.useQuery();

  const [selectedRecipe, setSelectedRecipe] = useState<RecipeListItem | null>(
    null,
  );
  const [editingSlotId, setEditingSlotId] = useState<number | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  // When the viewport shrinks below `lg`, the bank disappears — drop any
  // recipe that was selected for click-to-assign so the assignment-hint
  // banner doesn't outlive the bank that produced it.
  useEffect(() => {
    if (!isLargeViewport && selectedRecipe !== null) {
      setSelectedRecipe(null);
    }
  }, [isLargeViewport, selectedRecipe]);

  const { update, isPending } = useOptimisticSlotUpdate({
    planId,
    onError: (err) => {
      setMutationError(
        err instanceof Error ? err.message : 'Slot update failed',
      );
    },
  });

  const { relocate } = useOptimisticSlotRelocate({
    planId,
    onError: (err) => {
      setMutationError(
        err instanceof Error ? err.message : 'Slot relocation failed',
      );
    },
  });

  const editingSlot = useMemo<PlanSlot | null>(() => {
    if (editingSlotId === null) return null;
    return (
      planQuery.data?.slots.find((slot) => slot.id === editingSlotId) ?? null
    );
  }, [editingSlotId, planQuery.data]);

  // One pass per plan render — recomputed when the cache mutates. Treats cooked
  // base as a pool meals draw down (1:1) and walks the plan in cook-before-eat
  // order: `shortfallBySlot` flags slots that ate more base than was cooked so
  // far; `remainingByBase` is the end-of-plan leftover per base.
  const baseBalances = useMemo(
    () =>
      planQuery.data
        ? deriveBaseBalances(planQuery.data.slots)
        : {
            shortfallBySlot: new Map<number, number>(),
            remainingByBase: new Map<number, number>(),
          },
    [planQuery.data],
  );

  // Plant-points display (FEAT-41). Per-day badges via N batched `forDay`
  // queries; plan-total badge via a single `forPlan`. Cache invalidation on
  // slot mutations lives in the optimistic hooks themselves so the badges
  // refresh in lock-step with the slots they derive from.
  const visibleDateRange = useMemo(() => {
    if (!planQuery.data) return null;
    return clampRange(
      planQuery.data.startDate,
      planQuery.data.endDate,
      search.start,
      search.end,
    );
  }, [planQuery.data, search.start, search.end]);
  const visibleDates = useMemo(
    () =>
      visibleDateRange
        ? eachDateInRange(visibleDateRange.start, visibleDateRange.end)
        : [],
    [visibleDateRange],
  );
  const planTotalQuery = trpc.plants.forPlan.useQuery(
    { planId },
    { enabled: idIsValid && Boolean(planQuery.data) },
  );
  const dayPlantCounts = useDayPlantPoints(planId, visibleDates);

  if (!idIsValid) {
    return <p role="alert">Invalid plan id.</p>;
  }
  if (planQuery.isLoading) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading plan…
      </p>
    );
  }
  if (planQuery.error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {planQuery.error.message}
      </p>
    );
  }
  if (!planQuery.data) return <p role="alert">Plan not found.</p>;

  const plan = planQuery.data;
  const visible = clampRange(
    plan.startDate,
    plan.endDate,
    search.start,
    search.end,
  );

  function handleSlotClick(slot: PlanSlot): void {
    if (slot.slotType === 'empty' && selectedRecipe) {
      // Two-tap assign — bank selection + empty slot tap. The slot becomes a
      // single-dish "cooking in" occasion.
      update(assignSingleEat(slot.id, selectedRecipe));
      setSelectedRecipe(null);
      return;
    }
    // Anything else opens the editor sheet — including an empty slot when no
    // recipe is selected (lets the user pick a non-recipe state directly).
    setEditingSlotId(slot.id);
  }

  function handleSlotClear(slot: PlanSlot): void {
    setMutationError(null);
    // Full clear (meal + base) — empties the slot's items entirely.
    update({
      input: {
        slotId: slot.id,
        slotType: 'empty',
        leftoversSource: null,
        chefUserId: null,
        comment: null,
        items: [],
        dinerUserIds: [],
        guestCount: 0,
      },
      optimisticItems: [],
    });
  }

  function handleSave(
    input: UpdateSlotInput,
    options?: { optimisticItems?: PlanSlotItem[] },
  ): void {
    setMutationError(null);
    update({ input, optimisticItems: options?.optimisticItems });
    setEditingSlotId(null);
  }

  function handleDragAssign({
    recipe,
    slot,
  }: {
    recipe: RecipeListItem;
    slot: PlanSlot;
  }): void {
    setMutationError(null);
    update(assignSingleEat(slot.id, recipe));
  }

  function handleDragRelocate({
    sourceSlot,
    destSlot,
  }: {
    sourceSlot: PlanSlot;
    destSlot: PlanSlot;
  }): void {
    setMutationError(null);
    relocate({ sourceSlotId: sourceSlot.id, destSlotId: destSlot.id });
  }

  const plannerSection = (
    <section
      className={
        isLargeViewport
          ? 'mx-auto grid w-full max-w-6xl gap-4 lg:grid-cols-[16rem_1fr]'
          : 'mx-auto flex w-full max-w-6xl flex-col gap-4'
      }
    >
      {isLargeViewport && (
        <div className="lg:max-h-[calc(100vh-6rem)] lg:overflow-hidden">
          <RecipeBank
            selectedRecipeId={selectedRecipe?.id ?? null}
            onSelect={setSelectedRecipe}
            dndEnabled
          />
        </div>
      )}
      <div className="space-y-4">
        <header className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <h1 className="text-2xl font-semibold">
              {formatDayRangeLabel(plan.startDate, plan.endDate)}
            </h1>
            <PlantPointsBadge
              count={planTotalQuery.data?.count ?? null}
              variant="plan"
            />
          </div>
          <div className="flex items-center gap-3">
            {selectedRecipe && (
              <p className="text-sm text-muted-foreground" role="status">
                Tap an empty slot to assign “{selectedRecipe.name}”.
              </p>
            )}
            <Button asChild size="sm" variant="outline">
              <Link
                to="/plans/$planId/shopping"
                params={{ planId: String(plan.id) }}
              >
                Shopping list
              </Link>
            </Button>
          </div>
        </header>
        {mutationError && (
          <p role="alert" className="text-sm text-destructive">
            {mutationError}
          </p>
        )}
        {visible ? (
          <PlannerGrid
            slots={plan.slots}
            members={membersQuery.data?.members ?? []}
            rangeStart={visible.start}
            rangeEnd={visible.end}
            shortfallBySlot={baseBalances.shortfallBySlot}
            dayPlantCounts={dayPlantCounts}
            // Slot ↔ slot drag works at every viewport — touch-and-hold
            // (200 ms) lifts a populated slot, drops on another slot to
            // move or swap. Bank → slot still only at `lg+`, since the
            // bank itself is only mounted there.
            dndEnabled
            onSlotClick={handleSlotClick}
            onSlotClear={handleSlotClear}
          />
        ) : (
          <p className="text-sm text-muted-foreground" role="status">
            The selected date range is outside this plan.
          </p>
        )}
      </div>
      <SlotEditorSheet
        open={editingSlot !== null}
        slot={editingSlot}
        members={membersQuery.data?.members ?? []}
        isSaving={isPending}
        slots={plan.slots}
        onClose={() => {
          setEditingSlotId(null);
        }}
        onSave={handleSave}
      />
    </section>
  );

  // DndProvider wraps the planner at every viewport so slot ↔ slot drag
  // works on phones and tablets too. The bank → slot path only triggers
  // when the bank is mounted (lg+), so on smaller viewports the only
  // active DnD interaction is slot relocate/swap.
  return (
    <DndProvider
      onAssignRecipeToSlot={handleDragAssign}
      onRelocateSlot={handleDragRelocate}
    >
      {plannerSection}
    </DndProvider>
  );
}

// Assign a single eaten dish to a slot (bank click-to-assign + drag-drop): the
// slot becomes a one-item "cooking in" occasion. The optimistic item previews
// the dish name until the server row settles.
function assignSingleEat(
  slotId: number,
  recipe: RecipeListItem,
): { input: UpdateSlotInput; optimisticItems: PlanSlotItem[] } {
  return {
    input: {
      slotId,
      slotType: 'recipe',
      leftoversSource: null,
      chefUserId: null,
      comment: null,
      items: [
        {
          recipeId: recipe.id,
          servings: recipe.baseServings,
          kind: 'eat',
          sortOrder: 0,
        },
      ],
      dinerUserIds: [],
      guestCount: 0,
    },
    optimisticItems: [
      {
        id: 1,
        recipeId: recipe.id,
        recipeName: recipe.name,
        recipeImageUrl: recipe.imageUrl,
        isBase: recipe.isBase,
        baseRecipeId: recipe.baseRecipeId,
        isDeleted: recipe.isDeleted,
        servings: recipe.baseServings,
        kind: 'eat',
        sortOrder: 0,
      },
    ],
  };
}
