import type {
  HouseholdMember,
  PlanSlot,
  PlanSlotItem,
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
import { formatLongDayLabel } from '@/lib/date-utils.ts';
import { trpc } from '@/lib/trpc.ts';
import { cn } from '@/lib/utils.ts';

const SLOT_TYPE_OPTIONS: { value: SlotType; label: string }[] = [
  { value: 'recipe', label: 'Cooking in' },
  { value: 'eat_out', label: 'Eat out' },
  { value: 'takeaway', label: 'Takeaway' },
  { value: 'leftovers', label: 'Leftovers' },
  { value: 'empty', label: 'Empty' },
];

interface RecipeOption extends SearchableComboboxOption {
  recipe: RecipeListItem;
}

// One eaten dish being edited. Carries the recipe fields the card + save need;
// `servings` is a string so the input round-trips what the user types.
interface EditorEatItem {
  recipeId: number;
  name: string;
  imageUrl: string | null;
  isBase: boolean;
  baseRecipeId: number | null;
  isDeleted: boolean;
  servings: string;
}

interface EditorState {
  slotType: SlotType;
  chefUserId: string | null;
  comment: string;
  eatItems: EditorEatItem[];
}

export interface SlotEditorSheetProps {
  open: boolean;
  slot: PlanSlot | null;
  members: readonly HouseholdMember[];
  isSaving: boolean;
  onClose: () => void;
  onSave: (
    input: UpdateSlotInput,
    options?: { optimisticItems?: PlanSlotItem[] },
  ) => void;
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
      chefUserId: slot.chefUserId,
      comment: slot.comment ?? '',
      eatItems: slot.items
        .filter((item) => item.kind === 'eat')
        .map((item) => ({
          recipeId: item.recipeId,
          name: item.recipeName,
          imageUrl: item.recipeImageUrl,
          isBase: item.isBase,
          baseRecipeId: item.baseRecipeId,
          isDeleted: item.isDeleted,
          servings: String(item.servings),
        })),
    });
  }, [slot]);

  const utils = trpc.useUtils();

  if (!slot || !state) return null;

  function handleSubmit(event: React.SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!slot || !state) return;
    const built = buildInputForSave(slot, state);
    if (!built) return;
    onSave(built.input, { optimisticItems: built.optimisticItems });
  }

  function handleClear(): void {
    if (!slot) return;
    // Clears the eating side only — the slot's cook-ahead items (edited in the
    // Base modal) are preserved, so a base-only "prep" slot survives.
    const preserved = preservedCookAheadInput(slot);
    onSave(
      {
        slotId: slot.id,
        slotType: 'empty',
        chefUserId: null,
        comment: null,
        items: preserved.input,
      },
      { optimisticItems: preserved.optimistic },
    );
  }

  const showDishes = state.slotType === 'recipe';

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

          {showDishes && (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">Dishes</legend>
              {state.eatItems.map((item, index) => (
                <div
                  key={`${String(item.recipeId)}:${String(index)}`}
                  className="flex items-end gap-2"
                  data-testid="eat-item-row"
                >
                  <span className="flex-1 text-sm">
                    {item.name}
                    {item.isDeleted && (
                      <span className="ml-1 text-xs text-muted-foreground">
                        (deleted)
                      </span>
                    )}
                  </span>
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="font-medium">Servings</span>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      value={item.servings}
                      aria-label={`Servings for ${item.name}`}
                      onChange={(event) => {
                        const value = event.target.value;
                        setState((prev) =>
                          prev
                            ? {
                                ...prev,
                                eatItems: prev.eatItems.map((it, i) =>
                                  i === index ? { ...it, servings: value } : it,
                                ),
                              }
                            : prev,
                        );
                      }}
                      required
                      className="w-20"
                    />
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${item.name}`}
                    onClick={() => {
                      setState((prev) =>
                        prev
                          ? {
                              ...prev,
                              eatItems: prev.eatItems.filter(
                                (_, i) => i !== index,
                              ),
                            }
                          : prev,
                      );
                    }}
                  >
                    ×
                  </Button>
                </div>
              ))}
              <SearchableCombobox<RecipeOption>
                value={null}
                onChange={(option) => {
                  if (!option) return;
                  setState((prev) =>
                    prev
                      ? {
                          ...prev,
                          eatItems: [
                            ...prev.eatItems,
                            {
                              recipeId: option.recipe.id,
                              name: option.recipe.name,
                              imageUrl: option.recipe.imageUrl,
                              isBase: option.recipe.isBase,
                              baseRecipeId: option.recipe.baseRecipeId,
                              isDeleted: option.recipe.isDeleted,
                              servings: String(option.recipe.baseServings),
                            },
                          ],
                        }
                      : prev,
                  );
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
                ariaLabel="Add a dish"
                placeholder="Add a dish"
              />
            </fieldset>
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

interface BuiltSave {
  input: UpdateSlotInput;
  optimisticItems: PlanSlotItem[];
}

function buildInputForSave(
  slot: PlanSlot,
  state: EditorState,
): BuiltSave | null {
  const trimmedComment = state.comment.trim();
  const commentValue = trimmedComment === '' ? null : trimmedComment;

  // The meal editor owns the `eat` items; the slot's `cook_ahead` items are
  // edited in the Base modal and preserved verbatim here.
  const cookAhead = slot.items.filter((item) => item.kind === 'cook_ahead');

  const eatItems = state.slotType === 'recipe' ? state.eatItems : [];
  const parsedEat: { item: EditorEatItem; servings: number }[] = [];
  for (const item of eatItems) {
    const servings = Number.parseInt(item.servings, 10);
    if (!Number.isInteger(servings) || servings <= 0) return null;
    parsedEat.push({ item, servings });
  }

  const input: UpdateSlotInput = {
    slotId: slot.id,
    slotType: state.slotType,
    chefUserId: state.chefUserId,
    comment: commentValue,
    items: [
      ...parsedEat.map(({ item, servings }, index) => ({
        recipeId: item.recipeId,
        servings,
        kind: 'eat' as const,
        sortOrder: index,
      })),
      ...cookAhead.map((item, index) => ({
        recipeId: item.recipeId,
        servings: item.servings,
        kind: 'cook_ahead' as const,
        sortOrder: parsedEat.length + index,
      })),
    ],
  };

  const optimisticItems: PlanSlotItem[] = [
    ...parsedEat.map(({ item, servings }, index) => ({
      id: index + 1,
      recipeId: item.recipeId,
      recipeName: item.name,
      recipeImageUrl: item.imageUrl,
      isBase: item.isBase,
      baseRecipeId: item.baseRecipeId,
      isDeleted: item.isDeleted,
      servings,
      kind: 'eat' as const,
      sortOrder: index,
    })),
    ...cookAhead.map((item, index) => ({
      ...item,
      id: parsedEat.length + index + 1,
      sortOrder: parsedEat.length + index,
    })),
  ];

  return { input, optimisticItems };
}

// The slot's cook-ahead items as save input + optimistic display, used when the
// meal editor clears the eating side but must keep the prep.
function preservedCookAheadInput(slot: PlanSlot): {
  input: UpdateSlotInput['items'];
  optimistic: PlanSlotItem[];
} {
  const cookAhead = slot.items.filter((item) => item.kind === 'cook_ahead');
  return {
    input: cookAhead.map((item, index) => ({
      recipeId: item.recipeId,
      servings: item.servings,
      kind: 'cook_ahead' as const,
      sortOrder: index,
    })),
    optimistic: cookAhead.map((item, index) => ({
      ...item,
      id: index + 1,
      sortOrder: index,
    })),
  };
}
