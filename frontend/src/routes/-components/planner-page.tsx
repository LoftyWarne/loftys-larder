import type {
  PlanSlot,
  PlanSlotPairedRecipe,
  RecipeListItem,
  UpdateSlotInput,
} from '@loftys-larder/shared';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';

import { DndProvider } from '@/components/planner/dnd-provider.tsx';
import { PlannerGrid } from '@/components/planner/planner-grid.tsx';
import { RecipeBank } from '@/components/planner/recipe-bank.tsx';
import { SlotEditorSheet } from '@/components/planner/slot-editor-sheet.tsx';
import { Button } from '@/components/ui/button.tsx';
import { useIsLargeViewport } from '@/hooks/use-is-large-viewport.ts';
import { useOptimisticSlotRelocate } from '@/hooks/use-optimistic-slot-relocate.ts';
import { useOptimisticSlotUpdate } from '@/hooks/use-optimistic-slot-update.ts';
import { deriveBatchSupplyWarnings } from '@/lib/batch-supply.ts';
import { clampRange, formatDayRangeLabel } from '@/lib/date-utils.ts';
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

  // One pass per plan render — recomputed when the cache mutates. The set
  // holds slot ids whose eating recipe is a batch-version (recipe.baseRecipeId
  // !== null) with no earlier-or-same base cook in this plan.
  const batchWarningSlots = useMemo(
    () =>
      planQuery.data
        ? deriveBatchSupplyWarnings(planQuery.data.slots)
        : new Set<number>(),
    [planQuery.data],
  );

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
      // Two-tap assign — bank selection + empty slot tap.
      update({
        input: {
          slotId: slot.id,
          slotType: 'recipe',
          recipeId: selectedRecipe.id,
          numberOfServings: selectedRecipe.baseServings,
          chefUserId: null,
          cooksBaseRecipeId: null,
          cooksBaseServings: null,
          comment: null,
        },
        optimisticRecipe: {
          id: selectedRecipe.id,
          name: selectedRecipe.name,
          imageUrl: selectedRecipe.imageUrl,
          isBase: selectedRecipe.isBase,
          baseRecipeId: selectedRecipe.baseRecipeId,
          pairedRecipeId: selectedRecipe.pairedRecipeId,
          isDeleted: selectedRecipe.isDeleted,
        },
      });
      setSelectedRecipe(null);
      return;
    }
    // Anything else opens the editor sheet — including an empty slot when no
    // recipe is selected (lets the user pick a non-recipe state directly).
    setEditingSlotId(slot.id);
  }

  function handleSlotClear(slot: PlanSlot): void {
    setMutationError(null);
    update({
      input: {
        slotId: slot.id,
        slotType: 'empty',
        recipeId: null,
        numberOfServings: null,
        chefUserId: null,
        cooksBaseRecipeId: null,
        cooksBaseServings: null,
        comment: null,
      },
    });
  }

  function handleSave(
    input: UpdateSlotInput,
    options?: {
      optimisticRecipe?: RecipeListItem;
      optimisticPairedRecipe?: PlanSlotPairedRecipe | null;
    },
  ): void {
    setMutationError(null);
    const optimisticRecipe = options?.optimisticRecipe;
    update({
      input,
      optimisticRecipe: optimisticRecipe
        ? {
            id: optimisticRecipe.id,
            name: optimisticRecipe.name,
            imageUrl: optimisticRecipe.imageUrl,
            isBase: optimisticRecipe.isBase,
            baseRecipeId: optimisticRecipe.baseRecipeId,
            pairedRecipeId: optimisticRecipe.pairedRecipeId,
            isDeleted: optimisticRecipe.isDeleted,
          }
        : undefined,
      optimisticPairedRecipe: options?.optimisticPairedRecipe,
    });
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
    update({
      input: {
        slotId: slot.id,
        slotType: 'recipe',
        recipeId: recipe.id,
        numberOfServings: recipe.baseServings,
        chefUserId: null,
        cooksBaseRecipeId: null,
        cooksBaseServings: null,
        comment: null,
      },
      optimisticRecipe: {
        id: recipe.id,
        name: recipe.name,
        imageUrl: recipe.imageUrl,
        isBase: recipe.isBase,
        baseRecipeId: recipe.baseRecipeId,
        pairedRecipeId: recipe.pairedRecipeId,
        isDeleted: recipe.isDeleted,
      },
    });
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
          <h1 className="text-2xl font-semibold">
            {formatDayRangeLabel(plan.startDate, plan.endDate)}
          </h1>
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
            rangeStart={visible.start}
            rangeEnd={visible.end}
            warningSlotIds={batchWarningSlots}
            dndEnabled={isLargeViewport}
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
        hasBaseSupply={
          editingSlot === null || !batchWarningSlots.has(editingSlot.id)
        }
        onClose={() => {
          setEditingSlotId(null);
        }}
        onSave={handleSave}
      />
    </section>
  );

  if (isLargeViewport) {
    return (
      <DndProvider
        onAssignRecipeToSlot={handleDragAssign}
        onRelocateSlot={handleDragRelocate}
      >
        {plannerSection}
      </DndProvider>
    );
  }
  return plannerSection;
}
