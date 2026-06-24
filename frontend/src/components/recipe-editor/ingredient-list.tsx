import {
  type CreateIngredientInput,
  type IngredientReferences,
  type RecipeIngredientLine,
  type RecipeReferenceItem,
  type ReplaceRecipeIngredientsLine,
} from '@loftys-larder/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { IngredientForm } from '@/components/ingredient-form.tsx';
import {
  SearchableCombobox,
  type SearchableComboboxOption,
} from '@/components/searchable-combobox.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { Input } from '@/components/ui/input.tsx';
import { getDomainErrorCode } from '@/lib/domain-error.ts';

// Same regex as the shared `recipeQuantitySchema` — kept in lockstep so the
// client error matches what the server would reject.
const QUANTITY_REGEX = /^\d+(\.\d{1,3})?$/;
const QUANTITY_ERROR =
  'Quantity must be a non-negative number with up to 3 decimal places';

interface IngredientPickerOption extends SearchableComboboxOption {
  defaultUnitId: number;
  unitName: string;
}

interface DraftLine {
  // A stable client-side row id so React can key list mutations.
  rowKey: string;
  ingredient: IngredientPickerOption | null;
  quantity: string;
  prepTypeId: number | null;
  quantityError?: string;
  ingredientError?: string;
}

export interface ServerLineError {
  index: number;
  message: string;
}

// Serializable shape used by the draft autosave hook. Internal `DraftLine`
// state has a `rowKey` and per-row error strings that are React-only — a
// snapshot omits them so the persisted blob stays stable across mounts.
export interface IngredientDraftLine {
  ingredient: IngredientPickerOption | null;
  quantity: string;
  prepTypeId: number | null;
}

export interface IngredientListProps {
  initialLines: readonly RecipeIngredientLine[];
  // If provided, the editor seeds its state from these draft lines instead
  // of `initialLines`. Used by the draft autosave hook on mount; omit it
  // and the editor behaves exactly as before.
  initialDraftLines?: readonly IngredientDraftLine[];
  prepTypes: readonly RecipeReferenceItem[];
  searchIngredients: (
    query: string,
  ) =>
    | Promise<readonly IngredientPickerOption[]>
    | readonly IngredientPickerOption[];
  onSubmit: (lines: ReplaceRecipeIngredientsLine[]) => Promise<void>;
  // Reference data (categories + units) for the inline create form. When this
  // and `createIngredient` are both provided, the ingredient combobox offers a
  // "Create …" action for a name that isn't in the list yet. Omit either to
  // disable inline creation.
  references?: IngredientReferences;
  createIngredient?: (
    values: CreateIngredientInput,
  ) => Promise<IngredientPickerOption>;
  // Fires whenever the in-progress line list changes. Used by the draft
  // autosave hook — omit to opt out of autosave.
  onLinesChange?: (lines: IngredientDraftLine[]) => void;
  serverErrors?: readonly ServerLineError[];
  savedNoticeKey?: number;
}

function toDraft(line: RecipeIngredientLine, index: number): DraftLine {
  return {
    rowKey: `existing-${String(line.id)}-${String(index)}`,
    ingredient: {
      id: line.ingredientId,
      label: line.ingredientName,
      defaultUnitId: line.unitId,
      unitName: line.unitName,
    },
    quantity: line.quantity,
    prepTypeId: line.prepTypeId,
  };
}

let nextRowSeed = 0;
function newRowKey(): string {
  nextRowSeed += 1;
  return `new-${String(nextRowSeed)}`;
}

export function IngredientList({
  initialLines,
  initialDraftLines,
  prepTypes,
  searchIngredients,
  onSubmit,
  onLinesChange,
  serverErrors,
  savedNoticeKey,
  references,
  createIngredient,
}: IngredientListProps): React.ReactElement {
  // The row awaiting an inline-created ingredient, plus the typed name that
  // seeds the create form. `null` when the create dialog is closed.
  const [createState, setCreateState] = useState<{
    rowKey: string;
    name: string;
  } | null>(null);
  const [createNameError, setCreateNameError] = useState<string | undefined>();
  // Bumped per row to remount its combobox, which resets the input text. Used
  // when the create dialog is dismissed so the unmatched text the user typed
  // doesn't linger in the row.
  const [comboboxResetKey, setComboboxResetKey] = useState<
    Record<string, number>
  >({});
  const canCreate = references !== undefined && createIngredient !== undefined;
  const [lines, setLines] = useState<DraftLine[]>(() => {
    if (initialDraftLines) {
      return initialDraftLines.map((line) => ({
        rowKey: newRowKey(),
        ingredient: line.ingredient,
        quantity: line.quantity,
        prepTypeId: line.prepTypeId,
      }));
    }
    return initialLines.map(toDraft);
  });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!onLinesChange) return;
    onLinesChange(
      lines.map((line) => ({
        ingredient: line.ingredient,
        quantity: line.quantity,
        prepTypeId: line.prepTypeId,
      })),
    );
  }, [lines, onLinesChange]);

  const serverErrorsByIndex = useMemo(() => {
    const map = new Map<number, string>();
    for (const e of serverErrors ?? []) map.set(e.index, e.message);
    return map;
  }, [serverErrors]);

  const updateLine = useCallback(
    (rowKey: string, patch: Partial<DraftLine>) => {
      setLines((current) =>
        current.map((line) =>
          line.rowKey === rowKey ? { ...line, ...patch } : line,
        ),
      );
    },
    [],
  );

  const removeLine = useCallback((rowKey: string) => {
    setLines((current) => current.filter((line) => line.rowKey !== rowKey));
  }, []);

  const addLine = useCallback(() => {
    setLines((current) => [
      ...current,
      {
        rowKey: newRowKey(),
        ingredient: null,
        quantity: '',
        prepTypeId: null,
      },
    ]);
  }, []);

  // Close the create dialog without creating: clear the unmatched text from
  // the originating row's combobox by remounting it.
  function dismissCreate(): void {
    if (createState) {
      const { rowKey } = createState;
      setComboboxResetKey((current) => ({
        ...current,
        [rowKey]: (current[rowKey] ?? 0) + 1,
      }));
    }
    setCreateState(null);
    setCreateNameError(undefined);
  }

  async function handleCreateSubmit(
    values: CreateIngredientInput,
  ): Promise<void> {
    if (!createIngredient || !createState) return;
    setCreateNameError(undefined);
    try {
      const option = await createIngredient(values);
      updateLine(createState.rowKey, {
        ingredient: option,
        ingredientError: undefined,
      });
      setCreateState(null);
    } catch (error) {
      if (getDomainErrorCode(error) === 'INGREDIENT_NAME_TAKEN') {
        setCreateNameError('An ingredient with this name already exists');
        return;
      }
      throw error;
    }
  }

  async function handleSubmit(event: React.SyntheticEvent): Promise<void> {
    event.preventDefault();

    let firstInvalid = -1;
    const validated = lines.map((line, index) => {
      const updated: DraftLine = {
        ...line,
        quantityError: undefined,
        ingredientError: undefined,
      };
      if (!line.ingredient) {
        updated.ingredientError = 'Pick an ingredient';
        if (firstInvalid < 0) firstInvalid = index;
      }
      if (!QUANTITY_REGEX.test(line.quantity.trim())) {
        updated.quantityError = QUANTITY_ERROR;
        if (firstInvalid < 0) firstInvalid = index;
      }
      return updated;
    });

    if (firstInvalid >= 0) {
      setLines(validated);
      return;
    }

    const payload: ReplaceRecipeIngredientsLine[] = lines.map((line) => {
      const ingredient = line.ingredient;
      if (!ingredient) {
        // Unreachable — the validation loop above guarantees every line has
        // an ingredient picked before we get here.
        throw new Error('ingredient missing after validation');
      }
      return {
        ingredientId: ingredient.id,
        quantity: line.quantity.trim(),
        unitId: ingredient.defaultUnitId,
        prepTypeId: line.prepTypeId,
      };
    });

    setSubmitting(true);
    try {
      await onSubmit(payload);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <form
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
        className="space-y-4"
        noValidate
        aria-labelledby="recipe-ingredients-heading"
      >
        <h2 id="recipe-ingredients-heading" className="text-lg font-semibold">
          Ingredients
        </h2>

        {lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No ingredients yet. Click &ldquo;Add ingredient&rdquo; to start.
          </p>
        ) : (
          <ul className="space-y-3">
            {lines.map((line, index) => {
              const serverError = serverErrorsByIndex.get(index);
              return (
                <li
                  key={line.rowKey}
                  className="grid grid-cols-12 items-start gap-2"
                >
                  <div className="col-span-5 space-y-1">
                    <SearchableCombobox<IngredientPickerOption>
                      key={`${line.rowKey}-${String(
                        comboboxResetKey[line.rowKey] ?? 0,
                      )}`}
                      value={line.ingredient}
                      onChange={(option) => {
                        updateLine(line.rowKey, {
                          ingredient: option,
                          ingredientError: undefined,
                        });
                      }}
                      searchQuery={searchIngredients}
                      placeholder="Search ingredients"
                      ariaLabel={`Ingredient for row ${String(index + 1)}`}
                      onCreate={
                        canCreate
                          ? (query) => {
                              setCreateNameError(undefined);
                              setCreateState({
                                rowKey: line.rowKey,
                                name: query,
                              });
                            }
                          : undefined
                      }
                    />
                    {line.ingredientError && (
                      <p role="alert" className="text-sm text-destructive">
                        {line.ingredientError}
                      </p>
                    )}
                  </div>
                  <div className="col-span-2 space-y-1">
                    <Input
                      type="text"
                      inputMode="decimal"
                      placeholder="Qty"
                      aria-label={`Quantity for row ${String(index + 1)}`}
                      value={line.quantity}
                      onChange={(event) => {
                        updateLine(line.rowKey, {
                          quantity: event.target.value,
                          quantityError: undefined,
                        });
                      }}
                    />
                    {line.quantityError && (
                      <p role="alert" className="text-sm text-destructive">
                        {line.quantityError}
                      </p>
                    )}
                  </div>
                  <div className="col-span-2 text-sm text-muted-foreground">
                    {line.ingredient?.unitName ?? '—'}
                  </div>
                  <div className="col-span-2">
                    <select
                      aria-label={`Prep type for row ${String(index + 1)}`}
                      value={line.prepTypeId ?? ''}
                      onChange={(event) => {
                        updateLine(line.rowKey, {
                          prepTypeId:
                            event.target.value === ''
                              ? null
                              : Number(event.target.value),
                        });
                      }}
                      className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <option value="">No prep</option>
                      {prepTypes.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="col-span-1 flex justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove row ${String(index + 1)}`}
                      onClick={() => {
                        removeLine(line.rowKey);
                      }}
                    >
                      ×
                    </Button>
                  </div>
                  {serverError && (
                    <p
                      role="alert"
                      className="col-span-12 text-sm text-destructive"
                    >
                      {serverError}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="flex items-center justify-between">
          <Button type="button" variant="outline" onClick={addLine}>
            Add ingredient
          </Button>

          <div className="flex items-center gap-3">
            {savedNoticeKey !== undefined && (
              <p
                key={savedNoticeKey}
                role="status"
                className="text-sm text-emerald-600"
              >
                Saved.
              </p>
            )}
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Saving…' : 'Save ingredients'}
            </Button>
          </div>
        </div>
      </form>

      {references && createIngredient && createState && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) dismissCreate();
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New ingredient</DialogTitle>
              <DialogDescription>
                Adds a new ingredient to your household, then selects it for
                this line.
              </DialogDescription>
            </DialogHeader>
            <IngredientForm
              key={`${createState.rowKey}:${createState.name}`}
              references={references}
              defaultValues={{
                name: createState.name,
                categoryId: references.categories[0]?.id ?? 0,
                defaultUnitId: references.units[0]?.id ?? 0,
                isPlant: false,
                averageShelfLifeDays: null,
              }}
              submitLabel="Create ingredient"
              nameError={createNameError}
              onSubmit={handleCreateSubmit}
              onCancel={dismissCreate}
            />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

export type { IngredientPickerOption };
