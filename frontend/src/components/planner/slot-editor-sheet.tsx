import type {
  HouseholdMember,
  PlanSlot,
  PlanSlotCookedBase,
  PlanSlotPairedRecipe,
  RecipeListItem,
  SlotType,
  UpdateSlotInput,
} from '@loftys-larder/shared';
import { SLOT_COMMENT_MAX_LENGTH } from '@loftys-larder/shared';
import { useEffect, useId, useMemo, useState } from 'react';

import { BatchWarning } from '@/components/planner/batch-warning.tsx';
import { PairSwitchButton } from '@/components/planner/pair-switch-button.tsx';
import {
  SearchableCombobox,
  type SearchableComboboxOption,
} from '@/components/searchable-combobox.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { Input } from '@/components/ui/input.tsx';
import { formatLongDayLabel } from '@/lib/date-utils.ts';
import { trpc } from '@/lib/trpc.ts';
import { cn } from '@/lib/utils.ts';

const SLOT_TYPE_OPTIONS: { value: SlotType; label: string }[] = [
  { value: 'recipe', label: 'Recipe' },
  { value: 'eat_out', label: 'Eat out' },
  { value: 'takeaway', label: 'Takeaway' },
  { value: 'leftovers', label: 'Leftovers' },
  { value: 'empty', label: 'Empty' },
];

interface RecipeOption extends SearchableComboboxOption {
  recipe: RecipeListItem;
}

// `baseRecipe` carries only what the picker needs (id + name) — the editor
// never persists a full RecipeListItem for the cooked base, only the id +
// servings via UpdateSlotInput.
interface EditorBaseRecipe {
  id: number;
  name: string;
}

interface EditorState {
  slotType: SlotType;
  recipe: RecipeListItem | null;
  numberOfServings: string;
  chefUserId: string | null;
  baseRecipe: EditorBaseRecipe | null;
  baseServings: string;
  comment: string;
}

export interface SlotEditorSheetProps {
  open: boolean;
  slot: PlanSlot | null;
  members: readonly HouseholdMember[];
  isSaving: boolean;
  hasBaseSupply: boolean;
  onClose: () => void;
  onSave: (
    input: UpdateSlotInput,
    options?: {
      optimisticRecipe?: RecipeListItem;
      optimisticPairedRecipe?: PlanSlotPairedRecipe | null;
    },
  ) => void;
}

export function SlotEditorSheet({
  open,
  slot,
  members,
  isSaving,
  hasBaseSupply,
  onClose,
  onSave,
}: SlotEditorSheetProps): React.ReactElement | null {
  const formId = useId();
  const [state, setState] = useState<EditorState | null>(null);

  useEffect(() => {
    if (!slot) {
      setState(null);
      return;
    }
    setState({
      slotType: slot.slotType,
      // The bank's RecipeListItem isn't loaded here; the slot only carries the
      // minimal `PlanSlotRecipe`. Reuse via the combobox: when the user picks
      // a different recipe the picker hands us the full RecipeListItem.
      recipe: null,
      numberOfServings:
        slot.numberOfServings === null ? '' : String(slot.numberOfServings),
      chefUserId: slot.chefUserId,
      baseRecipe: cookedBaseToEditor(slot.cooksBaseRecipe),
      baseServings:
        slot.cooksBaseServings === null ? '' : String(slot.cooksBaseServings),
      comment: slot.comment ?? '',
    });
  }, [slot]);

  const utils = trpc.useUtils();

  // The meal-recipe header that informs the suggestion: prefer the freshly
  // picked recipe (full RecipeListItem in editor state) so a brand-new
  // batch-version pick can suggest its base on the same render; fall back to
  // the slot's current recipe if the user hasn't changed it.
  const mealRecipe = state?.recipe ?? null;
  const slotRecipe = slot?.recipe ?? null;
  const suggestedBaseRecipeId =
    mealRecipe?.baseRecipeId ??
    (slotRecipe && state?.recipe === null ? slotRecipe.baseRecipeId : null);

  // Only fetch the suggested base when the user has space to act on it.
  const showSuggestion =
    state !== null &&
    state.slotType === 'recipe' &&
    state.baseRecipe === null &&
    suggestedBaseRecipeId !== null;

  const suggestionQuery = trpc.recipes.get.useQuery(
    suggestedBaseRecipeId === null ? { id: 0 } : { id: suggestedBaseRecipeId },
    { enabled: showSuggestion },
  );

  const showBatchWarning =
    state !== null &&
    state.slotType === 'recipe' &&
    isBatchVersion(mealRecipe, slotRecipe, state.recipe) &&
    state.baseRecipe === null &&
    !hasBaseSupply;

  // Pair-switch destination — the slot's pairedRecipe sub-object joined by the
  // server. Surfaces only when the saved recipe has a pair AND the sibling is
  // not soft-deleted. If the user freshly picked a different recipe via the
  // combobox (state.recipe set), its sibling hasn't been loaded yet — the
  // affordance waits for save → re-select.
  const pairedForRender =
    state !== null &&
    state.slotType === 'recipe' &&
    state.recipe === null &&
    slot?.recipe?.pairedRecipeId != null &&
    slot.pairedRecipe !== null &&
    !slot.pairedRecipe.isDeleted
      ? slot.pairedRecipe
      : null;
  const currentIsBatchVersion =
    pairedForRender !== null && (slot?.recipe?.baseRecipeId ?? null) !== null;

  const baseSearchQuery = useMemo(() => {
    return async (query: string): Promise<readonly RecipeOption[]> => {
      const result = await utils.recipes.list.fetch({
        search: query || undefined,
        isBase: true,
        includePickerHidden: true,
        limit: 20,
      });
      return result.items.map((recipe) => ({
        id: recipe.id,
        label: recipe.name,
        recipe,
      }));
    };
  }, [utils]);

  if (!slot || !state) return null;

  function handleSubmit(event: React.SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!slot || !state) return;
    const input = buildInputForSave(slot, state);
    if (!input) return;
    onSave(input, { optimisticRecipe: state.recipe ?? undefined });
  }

  function handleClear(): void {
    if (!slot) return;
    onSave({
      slotId: slot.id,
      slotType: 'empty',
      recipeId: null,
      numberOfServings: null,
      chefUserId: null,
      cooksBaseRecipeId: null,
      cooksBaseServings: null,
      comment: null,
    });
  }

  function handlePairSwitch(): void {
    if (!slot) return;
    const paired = slot.pairedRecipe;
    const current = state?.recipe ?? slot.recipe;
    if (!paired || paired.isDeleted || !current) return;
    // The destination of the switch is `paired`; its sibling is the recipe
    // we're leaving (`current`). That's the optimistic-paired side until the
    // server re-selects.
    const optimisticRecipe: RecipeListItem = {
      id: paired.id,
      name: paired.name,
      imageUrl: paired.imageUrl,
      baseServings: paired.baseServings,
      activeTimeMins: null,
      totalTimeMins: null,
      isBase: paired.isBase,
      baseRecipeId: paired.baseRecipeId,
      pairedRecipeId: current.id,
      isDeleted: paired.isDeleted,
      plantPointsCount: 0,
      averageRating: null,
      ratingCount: 0,
    };
    const optimisticPairedRecipe: PlanSlotPairedRecipe = {
      id: current.id,
      name: current.name,
      imageUrl: current.imageUrl,
      isBase: current.isBase,
      baseRecipeId: current.baseRecipeId,
      // The current slot's PlanSlotRecipe doesn't carry baseServings; we don't
      // need it for the surviving (former) pair side because the next switch
      // would re-read the freshly-settled row. Default 1 keeps the type whole.
      baseServings: 1,
      isDeleted: current.isDeleted,
    };
    const trimmedComment = state ? state.comment.trim() : (slot.comment ?? '');
    onSave(
      {
        slotId: slot.id,
        slotType: 'recipe',
        recipeId: paired.id,
        numberOfServings: paired.baseServings,
        chefUserId: state?.chefUserId ?? slot.chefUserId,
        // Clear base-cook fields on pair switch — the suggestion hint
        // re-appears for the new recipe and the user picks fresh.
        cooksBaseRecipeId: null,
        cooksBaseServings: null,
        comment: trimmedComment === '' ? null : trimmedComment,
      },
      { optimisticRecipe, optimisticPairedRecipe },
    );
  }

  function handleApplySuggestion(): void {
    const suggested = suggestionQuery.data;
    if (!suggested) return;
    setState((prev) => {
      if (!prev) return prev;
      const next: EditorState = {
        ...prev,
        baseRecipe: { id: suggested.id, name: suggested.name },
      };
      if (prev.baseServings === '') {
        next.baseServings = String(suggested.baseServings);
      }
      return next;
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className={cn(
          'left-0 right-0 top-auto bottom-0 max-w-none translate-x-0 translate-y-0 rounded-t-lg rounded-b-none sm:bottom-auto sm:left-[50%] sm:right-auto sm:top-[50%] sm:max-w-lg sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-lg',
        )}
      >
        <DialogHeader>
          <DialogTitle>
            {slot.occasionName} · {formatLongDayLabel(slot.date)}
          </DialogTitle>
          <DialogDescription>
            Set what you&apos;re eating in this slot.
          </DialogDescription>
        </DialogHeader>
        <form
          id={formId}
          onSubmit={handleSubmit}
          className="flex flex-col gap-4"
        >
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Slot type</legend>
            <div className="flex flex-wrap gap-2">
              {SLOT_TYPE_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className={cn(
                    'flex cursor-pointer items-center gap-1 rounded-md border border-input px-3 py-1 text-sm transition',
                    state.slotType === option.value &&
                      'border-primary bg-accent',
                  )}
                >
                  <input
                    type="radio"
                    name="slotType"
                    value={option.value}
                    checked={state.slotType === option.value}
                    onChange={() => {
                      setState((prev) =>
                        prev ? { ...prev, slotType: option.value } : prev,
                      );
                    }}
                    className="sr-only"
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>

          {state.slotType === 'recipe' && (
            <>
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">Recipe</span>
                <SearchableCombobox<RecipeOption>
                  value={
                    state.recipe
                      ? {
                          id: state.recipe.id,
                          label: state.recipe.name,
                          recipe: state.recipe,
                        }
                      : slot.recipe
                        ? {
                            id: slot.recipe.id,
                            label: slot.recipe.name,
                            recipe: minimalRecipeListItem(
                              slot.recipe.id,
                              slot.recipe.name,
                              slot.recipe.baseRecipeId,
                            ),
                          }
                        : null
                  }
                  onChange={(option) => {
                    setState((prev) => {
                      if (!prev) return prev;
                      const recipe = option?.recipe ?? null;
                      const next = { ...prev, recipe };
                      if (recipe && prev.numberOfServings === '') {
                        next.numberOfServings = String(recipe.baseServings);
                      }
                      return next;
                    });
                  }}
                  searchQuery={async (query) => {
                    const result = await utils.recipes.list.fetch({
                      search: query || undefined,
                      includePickerHidden: true,
                      limit: 20,
                    });
                    return result.items.map((recipe) => ({
                      id: recipe.id,
                      label: recipe.name,
                      recipe,
                    }));
                  }}
                  ariaLabel="Search recipe"
                  placeholder="Search recipe"
                />
              </label>

              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">Servings</span>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={state.numberOfServings}
                  onChange={(event) => {
                    setState((prev) =>
                      prev
                        ? { ...prev, numberOfServings: event.target.value }
                        : prev,
                    );
                  }}
                  required
                />
              </label>

              {pairedForRender && (
                <PairSwitchButton
                  currentIsBatchVersion={currentIsBatchVersion}
                  pairedRecipeName={pairedForRender.name}
                  disabled={isSaving}
                  onClick={handlePairSwitch}
                />
              )}

              <fieldset className="flex flex-col gap-2 rounded-md border border-input bg-muted/30 p-2">
                <legend className="text-sm font-medium">
                  Cooking a base for batch use?
                </legend>
                <SearchableCombobox<RecipeOption>
                  value={
                    state.baseRecipe
                      ? {
                          id: state.baseRecipe.id,
                          label: state.baseRecipe.name,
                          recipe: minimalRecipeListItem(
                            state.baseRecipe.id,
                            state.baseRecipe.name,
                            null,
                          ),
                        }
                      : null
                  }
                  onChange={(option) => {
                    setState((prev) => {
                      if (!prev) return prev;
                      if (!option) {
                        return { ...prev, baseRecipe: null, baseServings: '' };
                      }
                      const next: EditorState = {
                        ...prev,
                        baseRecipe: {
                          id: option.recipe.id,
                          name: option.recipe.name,
                        },
                      };
                      if (prev.baseServings === '') {
                        next.baseServings = String(option.recipe.baseServings);
                      }
                      return next;
                    });
                  }}
                  searchQuery={baseSearchQuery}
                  ariaLabel="Search base recipe"
                  placeholder="Search base recipe"
                />
                {showSuggestion && suggestionQuery.data && (
                  <button
                    type="button"
                    onClick={handleApplySuggestion}
                    data-testid="base-suggestion-hint"
                    className="self-start rounded-md border border-dashed border-primary px-2 py-1 text-xs text-primary hover:bg-accent"
                  >
                    Suggested: {suggestionQuery.data.name} — use this?
                  </button>
                )}
                {state.baseRecipe !== null && (
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="font-medium">Base servings</span>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      value={state.baseServings}
                      onChange={(event) => {
                        setState((prev) =>
                          prev
                            ? { ...prev, baseServings: event.target.value }
                            : prev,
                        );
                      }}
                      required
                    />
                  </label>
                )}
                {showBatchWarning && <BatchWarning />}
              </fieldset>
            </>
          )}

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Chef</span>
            <select
              value={state.chefUserId ?? ''}
              onChange={(event) => {
                setState((prev) =>
                  prev
                    ? {
                        ...prev,
                        chefUserId:
                          event.target.value === '' ? null : event.target.value,
                      }
                    : prev,
                );
              }}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">Unassigned</option>
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Comment</span>
            <textarea
              value={state.comment}
              onChange={(event) => {
                setState((prev) =>
                  prev ? { ...prev, comment: event.target.value } : prev,
                );
              }}
              maxLength={SLOT_COMMENT_MAX_LENGTH}
              rows={3}
              className="rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
        </form>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={handleClear}
            disabled={isSaving}
          >
            Clear
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function buildInputForSave(
  slot: PlanSlot,
  state: EditorState,
): UpdateSlotInput | null {
  const trimmedComment = state.comment.trim();
  const commentValue = trimmedComment === '' ? null : trimmedComment;
  if (state.slotType === 'recipe') {
    const recipeId = state.recipe?.id ?? slot.recipeId;
    const servings = Number.parseInt(state.numberOfServings, 10);
    if (recipeId === null || !Number.isInteger(servings) || servings <= 0) {
      return null;
    }
    let cooksBaseRecipeId: number | null = null;
    let cooksBaseServings: number | null = null;
    if (state.baseRecipe !== null) {
      const baseServings = Number.parseInt(state.baseServings, 10);
      if (!Number.isInteger(baseServings) || baseServings <= 0) {
        return null;
      }
      cooksBaseRecipeId = state.baseRecipe.id;
      cooksBaseServings = baseServings;
    }
    return {
      slotId: slot.id,
      slotType: 'recipe',
      recipeId,
      numberOfServings: servings,
      chefUserId: state.chefUserId,
      cooksBaseRecipeId,
      cooksBaseServings,
      comment: commentValue,
    };
  }
  return {
    slotId: slot.id,
    slotType: state.slotType,
    recipeId: null,
    numberOfServings: null,
    chefUserId: state.chefUserId,
    cooksBaseRecipeId: null,
    cooksBaseServings: null,
    comment: commentValue,
  };
}

function cookedBaseToEditor(
  cooked: PlanSlotCookedBase | null,
): EditorBaseRecipe | null {
  if (!cooked) return null;
  return { id: cooked.id, name: cooked.name };
}

function isBatchVersion(
  mealRecipe: RecipeListItem | null,
  slotRecipe: PlanSlot['recipe'],
  editorRecipe: RecipeListItem | null,
): boolean {
  if (mealRecipe) return mealRecipe.baseRecipeId !== null;
  if (editorRecipe === null && slotRecipe) {
    return slotRecipe.baseRecipeId !== null;
  }
  return false;
}

// Cheap stand-in when only the slot's PlanSlotRecipe is known. The combobox
// only reads `id` + `label`; if the user keeps the existing recipe we pass the
// existing slot's recipeId at save time, so the placeholder values are never
// persisted.
function minimalRecipeListItem(
  id: number,
  name: string,
  baseRecipeId: number | null,
): RecipeListItem {
  return {
    id,
    name,
    imageUrl: null,
    baseServings: 1,
    activeTimeMins: null,
    totalTimeMins: null,
    isBase: false,
    baseRecipeId,
    pairedRecipeId: null,
    isDeleted: false,
    plantPointsCount: 0,
    averageRating: null,
    ratingCount: 0,
  };
}
