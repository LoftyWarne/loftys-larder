import type {
  HouseholdMember,
  PlanSlot,
  RecipeListItem,
  SlotType,
  UpdateSlotInput,
} from '@loftys-larder/shared';
import { SLOT_COMMENT_MAX_LENGTH } from '@loftys-larder/shared';
import { useEffect, useId, useState } from 'react';

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

interface EditorState {
  slotType: SlotType;
  recipe: RecipeListItem | null;
  numberOfServings: string;
  chefUserId: string | null;
  comment: string;
}

export interface SlotEditorSheetProps {
  open: boolean;
  slot: PlanSlot | null;
  members: readonly HouseholdMember[];
  isSaving: boolean;
  onClose: () => void;
  onSave: (input: UpdateSlotInput, optimisticRecipe?: RecipeListItem) => void;
}

export function SlotEditorSheet({
  open,
  slot,
  members,
  isSaving,
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
      comment: slot.comment ?? '',
    });
  }, [slot]);

  const utils = trpc.useUtils();

  if (!slot || !state) return null;

  function handleSubmit(event: React.SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!slot || !state) return;
    const input = buildInputForSave(slot, state);
    if (!input) return;
    onSave(input, state.recipe ?? undefined);
  }

  function handleClear(): void {
    if (!slot) return;
    onSave({
      slotId: slot.id,
      slotType: 'empty',
      recipeId: null,
      numberOfServings: null,
      chefUserId: null,
      comment: null,
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
        // Bottom-sheet positioning on small screens; centered on larger ones.
        // Replaces the default Dialog centered placement.
        className={cn(
          'left-0 right-0 top-auto bottom-0 max-w-none translate-x-0 translate-y-0 rounded-t-lg rounded-b-none sm:bottom-auto sm:left-[50%] sm:right-auto sm:top-[50%] sm:max-w-lg sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-lg',
        )}
      >
        <DialogHeader>
          <DialogTitle>
            {slot.occasionName} · {slot.date}
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
    return {
      slotId: slot.id,
      slotType: 'recipe',
      recipeId,
      numberOfServings: servings,
      chefUserId: state.chefUserId,
      comment: commentValue,
    };
  }
  return {
    slotId: slot.id,
    slotType: state.slotType,
    recipeId: null,
    numberOfServings: null,
    chefUserId: state.chefUserId,
    comment: commentValue,
  };
}

// Cheap stand-in when only the slot's PlanSlotRecipe is known. The combobox
// only reads `id` + `label`; if the user keeps the existing recipe we pass the
// existing slot's recipeId at save time, so the placeholder values are never
// persisted.
function minimalRecipeListItem(id: number, name: string): RecipeListItem {
  return {
    id,
    name,
    imageUrl: null,
    baseServings: 1,
    activeTimeMins: null,
    totalTimeMins: null,
    isBase: false,
    baseRecipeId: null,
    pairedRecipeId: null,
    isDeleted: false,
    plantPointsCount: 0,
    averageRating: null,
    ratingCount: 0,
  };
}
