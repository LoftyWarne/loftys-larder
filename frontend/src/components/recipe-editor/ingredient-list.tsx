import {
  type CreateIngredientInput,
  type IngredientReferences,
  type RecipeIngredientLine,
  type RecipeReferenceItem,
  type ReplaceRecipeIngredientsLine,
} from '@loftys-larder/shared';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';

import { IngredientForm } from '@/components/ingredient-form.tsx';
import type { RecipeSectionHandle } from '@/components/recipe-editor/section-handle.ts';
import {
  SearchableCombobox,
  type SearchableComboboxHandle,
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip.tsx';
import { getDomainErrorCode } from '@/lib/domain-error.ts';
import {
  isValidQuantityEntry,
  parseQuantityToDecimal,
  sanitizeQuantityInput,
  trimTrailingZeros,
} from '@/lib/quantity-input.ts';

const QUANTITY_ERROR =
  'Enter a number or simple fraction, e.g. 1.5 or 1/2 (up to 3 decimal places)';

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
  // Set on blur; cleared while typing. Gates the live quantity error so a
  // partially-typed value (`1/`, `1.`) doesn't flash an error mid-entry.
  quantityTouched?: boolean;
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
  // Resolves `true` once the lines are saved and `false` when validation
  // fails or the save is rejected, so "Save & Finish" can gate navigation.
  onSubmit: (lines: ReplaceRecipeIngredientsLine[]) => Promise<boolean>;
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
    // The DB pads to scale (`50` → `50.000`); show no more precision than the
    // value needs.
    quantity: trimTrailingZeros(line.quantity),
    prepTypeId: line.prepTypeId,
  };
}

let nextRowSeed = 0;
function newRowKey(): string {
  nextRowSeed += 1;
  return `new-${String(nextRowSeed)}`;
}

// A line is complete once it has an ingredient picked and a well-formed
// quantity. Shared by the "Add ingredient" gate and the submit validation so
// the two never drift.
function isLineValid(line: DraftLine): boolean {
  return line.ingredient !== null && isValidQuantityEntry(line.quantity);
}

// Row keys of lines that repeat an earlier line's (ingredient, prep type)
// pair. DEC-20 keeps *different* prep types apart ("onion sliced" + "onion
// diced"), so the key includes the prep type — only an exact match is a
// duplicate. The first occurrence is kept; every later match is flagged.
function findDuplicateRowKeys(lines: readonly DraftLine[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const line of lines) {
    if (!line.ingredient) continue;
    const key = `${String(line.ingredient.id)}:${String(line.prepTypeId ?? '')}`;
    if (seen.has(key)) duplicates.add(line.rowKey);
    else seen.add(key);
  }
  return duplicates;
}

export const IngredientList = forwardRef<
  RecipeSectionHandle,
  IngredientListProps
>(function IngredientList(
  {
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
  },
  ref,
): React.ReactElement {
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

  // The "Saved." notice is shown after a save, then cleared the moment the user
  // edits a line again — a stale "Saved." sitting next to unsaved changes is
  // misleading. A new `savedNoticeKey` (bumped by the page on every save) turns
  // it back on; the line mutators below turn it off.
  const [savedVisible, setSavedVisible] = useState(false);
  useEffect(() => {
    if (savedNoticeKey === undefined) return;
    setSavedVisible(true);
  }, [savedNoticeKey]);

  // Combobox handles keyed by row, so a freshly added row can be focused. The
  // ref callback self-cleans: React calls it with `null` when a row unmounts.
  const comboboxRefs = useRef<Map<string, SearchableComboboxHandle | null>>(
    new Map(),
  );
  // Set to the rowKey of a just-added line; the effect below focuses its
  // combobox once the row has rendered, then clears this.
  const [pendingFocusRowKey, setPendingFocusRowKey] = useState<string | null>(
    null,
  );
  useEffect(() => {
    if (!pendingFocusRowKey) return;
    comboboxRefs.current.get(pendingFocusRowKey)?.focus();
    setPendingFocusRowKey(null);
  }, [pendingFocusRowKey, lines]);

  // Autosave only on real edits. Emitting on mount (or on a bare re-render —
  // onLinesChange is an inline prop, so its identity changes each render) would
  // mark this section dirty even when untouched, leaving a draft row that can
  // never be cleared. Mirrors the header's form.watch behaviour.
  const lastEmittedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!onLinesChange) return;
    const payload = lines.map((line) => ({
      ingredient: line.ingredient,
      quantity: line.quantity,
      prepTypeId: line.prepTypeId,
    }));
    const serialized = JSON.stringify(payload);
    if (lastEmittedRef.current === null) {
      lastEmittedRef.current = serialized;
      return;
    }
    if (lastEmittedRef.current === serialized) return;
    lastEmittedRef.current = serialized;
    onLinesChange(payload);
  }, [lines, onLinesChange]);

  const serverErrorsByIndex = useMemo(() => {
    const map = new Map<number, string>();
    for (const e of serverErrors ?? []) map.set(e.index, e.message);
    return map;
  }, [serverErrors]);

  const updateLine = useCallback(
    (rowKey: string, patch: Partial<DraftLine>) => {
      setSavedVisible(false);
      setLines((current) =>
        current.map((line) =>
          line.rowKey === rowKey ? { ...line, ...patch } : line,
        ),
      );
    },
    [],
  );

  const removeLine = useCallback((rowKey: string) => {
    setSavedVisible(false);
    setLines((current) => current.filter((line) => line.rowKey !== rowKey));
  }, []);

  const addLine = useCallback(() => {
    setSavedVisible(false);
    const rowKey = newRowKey();
    setLines((current) => [
      ...current,
      {
        rowKey,
        ingredient: null,
        quantity: '',
        prepTypeId: null,
      },
    ]);
    setPendingFocusRowKey(rowKey);
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

  const runSubmit = useCallback(async (): Promise<boolean> => {
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
      if (!isValidQuantityEntry(line.quantity)) {
        updated.quantityError = QUANTITY_ERROR;
        if (firstInvalid < 0) firstInvalid = index;
      }
      return updated;
    });

    // Duplicate (ingredient, prep) rows are surfaced inline as they occur, but
    // block the save too — nothing should slip through if the user reaches the
    // button without touching the offending row again.
    if (firstInvalid >= 0 || findDuplicateRowKeys(lines).size > 0) {
      setLines(validated);
      return false;
    }

    const payload: ReplaceRecipeIngredientsLine[] = lines.map((line) => {
      const ingredient = line.ingredient;
      if (!ingredient) {
        // Unreachable — the validation loop above guarantees every line has
        // an ingredient picked before we get here.
        throw new Error('ingredient missing after validation');
      }
      const quantity = parseQuantityToDecimal(line.quantity);
      if (quantity === null) {
        // Unreachable — validation above rejects anything unparseable.
        throw new Error('quantity invalid after validation');
      }
      return {
        ingredientId: ingredient.id,
        quantity,
        unitId: ingredient.defaultUnitId,
        prepTypeId: line.prepTypeId,
      };
    });

    setSubmitting(true);
    try {
      return await onSubmit(payload);
    } finally {
      setSubmitting(false);
    }
  }, [lines, onSubmit]);

  useImperativeHandle(ref, () => ({ submit: runSubmit }), [runSubmit]);

  const duplicateRowKeys = useMemo(() => findDuplicateRowKeys(lines), [lines]);
  // Why "Add ingredient" is disabled, or null when it's usable. Duplicates are
  // called out first — it's the more specific fix. Drives both the button gate
  // and the tooltip so they can never disagree.
  const addDisabledReason =
    duplicateRowKeys.size > 0
      ? 'Resolve the duplicate ingredient before adding another'
      : !lines.every(isLineValid)
        ? 'Give each ingredient a name and quantity before adding another'
        : null;
  const canAddLine = addDisabledReason === null;

  return (
    <TooltipProvider delayDuration={200}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void runSubmit();
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
              // Show the quantity error after the field is blurred (or a submit
              // set it), never mid-typing — so a partially-typed `1/` or `1.`
              // on the way to a valid value doesn't flash an error.
              const showQuantityError =
                line.quantityError !== undefined ||
                (line.quantityTouched === true &&
                  line.quantity.trim() !== '' &&
                  !isValidQuantityEntry(line.quantity));
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
                      ref={(handle) => {
                        comboboxRefs.current.set(line.rowKey, handle);
                      }}
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
                      createOnBlur={canCreate}
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
                    {duplicateRowKeys.has(line.rowKey) && (
                      <p role="alert" className="text-sm text-destructive">
                        This ingredient is already in the list with the same
                        prep type
                      </p>
                    )}
                  </div>
                  <div className="col-span-2 space-y-1">
                    <Input
                      type="text"
                      // `text`, not `decimal`, so the `/` for fractions is on
                      // the mobile keyboard; sanitize keeps input to digits and
                      // a single `.` or `/`.
                      inputMode="text"
                      placeholder="Qty"
                      aria-label={`Quantity for row ${String(index + 1)}`}
                      value={line.quantity}
                      onChange={(event) => {
                        updateLine(line.rowKey, {
                          quantity: sanitizeQuantityInput(event.target.value),
                          quantityError: undefined,
                          quantityTouched: false,
                        });
                      }}
                      onBlur={() => {
                        updateLine(line.rowKey, { quantityTouched: true });
                      }}
                    />
                    {showQuantityError && (
                      <p role="alert" className="text-sm text-destructive">
                        {QUANTITY_ERROR}
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
          <Tooltip>
            {/* The trigger wraps a span, not the Button directly: a disabled
                button has `pointer-events-none`, so it never fires the hover
                events the tooltip listens for. Hover lands on the span. */}
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  type="button"
                  variant="outline"
                  onClick={addLine}
                  disabled={!canAddLine}
                >
                  Add ingredient
                </Button>
              </span>
            </TooltipTrigger>
            {/* Rendered only while disabled, so a usable button has no tooltip. */}
            {addDisabledReason && (
              <TooltipContent>{addDisabledReason}</TooltipContent>
            )}
          </Tooltip>

          <div className="flex items-center gap-3">
            {savedVisible && (
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
    </TooltipProvider>
  );
});

export type { IngredientPickerOption };
