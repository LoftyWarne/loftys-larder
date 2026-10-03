import type {
  RecipeMethodStep,
  ReplaceRecipeMethodStepInput,
  StepPrepAhead,
} from '@loftys-larder/shared';
import {
  RECIPE_INSTRUCTION_MAX_LENGTH,
  RECIPE_STEP_NOTE_MAX_LENGTH,
  stepPrepAheadSchema,
} from '@loftys-larder/shared';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { RecipeSectionHandle } from '@/components/recipe-editor/section-handle.ts';
import {
  StepNoteCallout,
  type StepNoteKind,
} from '@/components/step-note-callout.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip.tsx';
import {
  isValidQuantityEntry,
  parseQuantityToDecimal,
  sanitizeQuantityInput,
  trimTrailingZeros,
} from '@/lib/quantity-input.ts';
import {
  type StepIngredientSuggestion,
  suggestStepIngredients,
} from '@/lib/step-ingredient-suggestions.ts';

// An ingredient on the recipe as the Ingredients section currently shows it,
// one entry per ingredient. `total` pools its lines and is `null` while any of
// them has no valid quantity.
export interface MethodIngredient {
  ingredientId: number;
  name: string;
  unitName: string;
  total: number | null;
}

// A step's link to an ingredient (DEC-99). `quantity` is as typed; `''` means
// not stated.
interface DraftStepIngredient {
  ingredientId: number;
  quantity: string;
}

// `null` means the note is closed; an open-but-empty note is `''` and is sent
// as `null` on save. `followsText` is true until the step's ingredient chips
// are edited by hand; until then they're re-suggested from the text as it's
// typed.
interface DraftStep {
  rowKey: string;
  instruction: string;
  safetyNote: string | null;
  tip: string | null;
  prepAhead: StepPrepAhead | null;
  ingredients: DraftStepIngredient[];
  followsText: boolean;
  error?: string;
  ingredientsError?: string;
}

export interface MethodDraftStep {
  instruction: string;
  // Optional because autosaved drafts from before step notes don't carry them.
  safetyNote?: string | null;
  tip?: string | null;
  prepAhead?: StepPrepAhead | null;
  // Optional because autosaved drafts from before step ingredients don't
  // carry them.
  ingredients?: DraftStepIngredient[];
  followsText?: boolean;
}

type NoteField = 'safetyNote' | 'tip';

const NOTE_FIELDS: readonly {
  field: NoteField;
  kind: StepNoteKind;
  noun: string;
  addLabel: string;
}[] = [
  {
    field: 'safetyNote',
    kind: 'safety',
    noun: 'safety note',
    addLabel: 'Safety note',
  },
  { field: 'tip', kind: 'tip', noun: 'tip', addLabel: 'Tip' },
];

const PREP_AHEAD_OPTIONS: readonly {
  value: StepPrepAhead | '';
  label: string;
}[] = [
  { value: '', label: 'On the day' },
  { value: 'optional', label: 'Can be done ahead' },
  { value: 'required', label: 'Must be done ahead' },
];

// Autosaved drafts are untyped JSON, so anything unrecognised reads as "on the
// day" rather than reaching the server as an invalid enum value.
function parsePrepAhead(value: unknown): StepPrepAhead | null {
  const parsed = stepPrepAheadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// Autosaved drafts are untyped JSON; anything malformed reads as no chips.
function parseDraftIngredients(value: unknown): DraftStepIngredient[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return [];
    const { ingredientId, quantity } = item as Record<string, unknown>;
    if (
      typeof ingredientId !== 'number' ||
      !Number.isInteger(ingredientId) ||
      ingredientId <= 0
    ) {
      return [];
    }
    return [
      {
        ingredientId,
        quantity: typeof quantity === 'string' ? quantity : '',
      },
    ];
  });
}

function toDraftIngredients(
  suggestions: readonly StepIngredientSuggestion[],
): DraftStepIngredient[] {
  return suggestions.map(({ ingredientId, quantity }) => ({
    ingredientId,
    quantity: quantity ?? '',
  }));
}

function toMilli(quantity: string): number {
  return Math.round(Number(quantity) * 1000);
}

function toNotePayload(note: string | null): string | null {
  const trimmed = note?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

export interface MethodEditorProps {
  initialSteps: readonly RecipeMethodStep[];
  // If provided, the editor seeds its state from these draft steps instead
  // of `initialSteps`. Used by the draft autosave hook on mount; omit it
  // and the editor behaves exactly as before.
  initialDraftSteps?: readonly MethodDraftStep[];
  // Resolves `true` once the steps are saved and `false` when validation
  // fails or the save is rejected, so "Save & Finish" can gate navigation.
  onSubmit: (steps: ReplaceRecipeMethodStepInput[]) => Promise<boolean>;
  // Fires whenever the in-progress step list changes. Used by the draft
  // autosave hook — omit to opt out of autosave.
  onStepsChange?: (steps: MethodDraftStep[]) => void;
  savedNoticeKey?: number;
  // The recipe's ingredients as the Ingredients section shows them, unsaved
  // edits included. Steps can only link to these.
  recipeIngredients?: readonly MethodIngredient[];
}

const NO_INGREDIENTS: readonly MethodIngredient[] = [];

let nextRowSeed = 0;
function newRowKey(): string {
  nextRowSeed += 1;
  return `new-${String(nextRowSeed)}`;
}

// Shared by the "Add step" gate and the submit validation so the two never
// drift.
function isStepValid(step: DraftStep): boolean {
  return step.instruction.trim().length > 0;
}

function toDraft(step: RecipeMethodStep): DraftStep {
  return {
    rowKey: `existing-${String(step.id)}`,
    instruction: step.instruction,
    safetyNote: step.safetyNote,
    tip: step.tip,
    prepAhead: step.prepAhead,
    ingredients: step.ingredients.map((link) => ({
      ingredientId: link.ingredientId,
      quantity: link.quantity === null ? '' : trimTrailingZeros(link.quantity),
    })),
    followsText: step.ingredients.length === 0,
  };
}

export const MethodEditor = forwardRef<RecipeSectionHandle, MethodEditorProps>(
  function MethodEditor(
    {
      initialSteps,
      initialDraftSteps,
      onSubmit,
      onStepsChange,
      savedNoticeKey,
      recipeIngredients = NO_INGREDIENTS,
    },
    ref,
  ): React.ReactElement {
    const [steps, setSteps] = useState<DraftStep[]>(() => {
      if (initialDraftSteps) {
        return initialDraftSteps.map((step) => {
          const ingredients = parseDraftIngredients(step.ingredients);
          return {
            rowKey: newRowKey(),
            instruction: step.instruction,
            safetyNote: step.safetyNote ?? null,
            tip: step.tip ?? null,
            prepAhead: parsePrepAhead(step.prepAhead),
            ingredients,
            followsText:
              typeof step.followsText === 'boolean'
                ? step.followsText
                : ingredients.length === 0,
          };
        });
      }
      return initialSteps.map(toDraft);
    });

    // Read from the step mutators below, which stay referentially stable.
    const recipeIngredientsRef = useRef(recipeIngredients);
    recipeIngredientsRef.current = recipeIngredients;
    const ingredientById = useMemo(
      () => new Map(recipeIngredients.map((item) => [item.ingredientId, item])),
      [recipeIngredients],
    );
    const suggestionsByRow = useMemo(
      () =>
        new Map(
          steps.map((step) => [
            step.rowKey,
            suggestStepIngredients(step.instruction, recipeIngredients),
          ]),
        ),
      [steps, recipeIngredients],
    );

    // Stated amounts can't add up to more than the recipe total (DEC-99).
    // Checked against the Ingredients section as shown, so it updates live.
    const overTotalMessages = useMemo(() => {
      const statedMilli = new Map<number, number>();
      for (const step of steps) {
        for (const link of step.ingredients) {
          const parsed = parseQuantityToDecimal(link.quantity);
          if (parsed === null || !ingredientById.has(link.ingredientId)) {
            continue;
          }
          statedMilli.set(
            link.ingredientId,
            (statedMilli.get(link.ingredientId) ?? 0) + toMilli(parsed),
          );
        }
      }
      return recipeIngredients.flatMap((item) => {
        const stated = statedMilli.get(item.ingredientId);
        if (stated === undefined || item.total === null) return [];
        if (stated <= Math.round(item.total * 1000)) return [];
        return [
          `${item.name}: the steps use ${String(stated / 1000)} ${item.unitName}, but the recipe has ${String(item.total)} ${item.unitName}.`,
        ];
      });
    }, [steps, recipeIngredients, ingredientById]);

    // Autosave only on real edits. Emitting on mount (or on a bare re-render —
    // onStepsChange is an inline prop, so its identity changes each render)
    // would mark this section dirty even when untouched, leaving a draft row
    // that can never be cleared. Mirrors the header's form.watch behaviour.
    const lastEmittedRef = useRef<string | null>(null);
    useEffect(() => {
      if (!onStepsChange) return;
      const payload = steps.map((step) => ({
        instruction: step.instruction,
        safetyNote: step.safetyNote,
        tip: step.tip,
        prepAhead: step.prepAhead,
        ingredients: step.ingredients,
        followsText: step.followsText,
      }));
      const serialized = JSON.stringify(payload);
      if (lastEmittedRef.current === null) {
        lastEmittedRef.current = serialized;
        return;
      }
      if (lastEmittedRef.current === serialized) return;
      lastEmittedRef.current = serialized;
      onStepsChange(payload);
    }, [steps, onStepsChange]);
    const [submitting, setSubmitting] = useState(false);

    // The "Saved." notice is shown after a save, then cleared the moment the
    // user edits a step again — a stale "Saved." sitting next to unsaved
    // changes is misleading. A new `savedNoticeKey` (bumped by the page on
    // every save) turns it back on; the step mutators below turn it off.
    const [savedVisible, setSavedVisible] = useState(false);
    useEffect(() => {
      if (savedNoticeKey === undefined) return;
      setSavedVisible(true);
    }, [savedNoticeKey]);

    const focusNewIndex = useRef<number | null>(null);
    const focusNoteKey = useRef<string | null>(null);
    const textareaRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map());

    // Resetting height to `auto` briefly collapses the textarea so we can read
    // its true scrollHeight. That collapse shrinks the document, which can make
    // the browser clamp the scroll position — so capture and restore it.
    const autosize = useCallback((el: HTMLTextAreaElement) => {
      const { scrollX, scrollY } = window;
      el.style.height = 'auto';
      el.style.height = `${String(el.scrollHeight)}px`;
      if (window.scrollX !== scrollX || window.scrollY !== scrollY) {
        window.scrollTo(scrollX, scrollY);
      }
    }, []);

    // Size the initially-seeded steps once after mount. Typing is handled in the
    // textarea's onChange; we deliberately do NOT autosize on every ref attach,
    // because the ref callback re-runs on every render and would thrash heights
    // (and the scroll position) when an unrelated re-render occurs.
    useLayoutEffect(() => {
      for (const el of textareaRefs.current.values()) {
        autosize(el);
      }
    }, [autosize]);

    const updateStep = useCallback((rowKey: string, instruction: string) => {
      setSavedVisible(false);
      setSteps((current) =>
        current.map((step) => {
          if (step.rowKey !== rowKey) return step;
          const ingredients = step.followsText
            ? toDraftIngredients(
                suggestStepIngredients(
                  instruction,
                  recipeIngredientsRef.current,
                ),
              )
            : step.ingredients;
          return { ...step, instruction, ingredients, error: undefined };
        }),
      );
    }, []);

    // Any hand edit to a step's chips stops them following its text.
    const editIngredients = useCallback(
      (
        rowKey: string,
        edit: (links: DraftStepIngredient[]) => DraftStepIngredient[],
      ) => {
        setSavedVisible(false);
        setSteps((current) =>
          current.map((step) =>
            step.rowKey === rowKey
              ? {
                  ...step,
                  ingredients: edit(step.ingredients),
                  followsText: false,
                  ingredientsError: undefined,
                }
              : step,
          ),
        );
      },
      [],
    );

    const setNote = useCallback(
      (rowKey: string, field: NoteField, value: string | null) => {
        setSavedVisible(false);
        setSteps((current) =>
          current.map((step) =>
            step.rowKey === rowKey ? { ...step, [field]: value } : step,
          ),
        );
      },
      [],
    );

    const setPrepAhead = useCallback(
      (rowKey: string, prepAhead: StepPrepAhead | null) => {
        setSavedVisible(false);
        setSteps((current) =>
          current.map((step) =>
            step.rowKey === rowKey ? { ...step, prepAhead } : step,
          ),
        );
      },
      [],
    );

    const openNote = useCallback(
      (rowKey: string, field: NoteField) => {
        focusNoteKey.current = `${rowKey}:${field}`;
        setNote(rowKey, field, '');
      },
      [setNote],
    );

    const removeStep = useCallback((rowKey: string) => {
      setSavedVisible(false);
      setSteps((current) => current.filter((step) => step.rowKey !== rowKey));
    }, []);

    const moveStep = useCallback((index: number, direction: -1 | 1) => {
      setSavedVisible(false);
      setSteps((current) => {
        const next = [...current];
        const target = index + direction;
        if (target < 0 || target >= next.length) return current;
        const a = next[index];
        const b = next[target];
        if (!a || !b) return current;
        next[index] = b;
        next[target] = a;
        return next;
      });
    }, []);

    const addStep = useCallback(() => {
      setSavedVisible(false);
      setSteps((current) => {
        focusNewIndex.current = current.length;
        return [
          ...current,
          {
            rowKey: newRowKey(),
            instruction: '',
            safetyNote: null,
            tip: null,
            prepAhead: null,
            ingredients: [],
            followsText: true,
          },
        ];
      });
    }, []);

    // Focus the most-recently-added step's textarea once it renders.
    function registerTextarea(
      rowKey: string,
      el: HTMLTextAreaElement | null,
    ): void {
      if (el) {
        textareaRefs.current.set(rowKey, el);
        const stepIndex = steps.findIndex((s) => s.rowKey === rowKey);
        if (
          focusNewIndex.current !== null &&
          stepIndex === focusNewIndex.current
        ) {
          el.focus();
          focusNewIndex.current = null;
        }
      } else {
        textareaRefs.current.delete(rowKey);
      }
    }

    // Note textareas share `textareaRefs` (keyed `rowKey:field`) so the mount
    // autosize pass covers seeded notes too.
    function registerNoteTextarea(
      noteKey: string,
      el: HTMLTextAreaElement | null,
    ): void {
      if (el) {
        textareaRefs.current.set(noteKey, el);
        if (focusNoteKey.current === noteKey) {
          el.focus();
          focusNoteKey.current = null;
        }
      } else {
        textareaRefs.current.delete(noteKey);
      }
    }

    const runSubmit = useCallback(async (): Promise<boolean> => {
      let firstInvalid = -1;
      const validated = steps.map((step, index) => {
        const error = isStepValid(step) ? undefined : 'Step text is required';
        const ingredientsError = step.ingredients.every(
          (link) =>
            link.quantity.trim() === '' ||
            (isValidQuantityEntry(link.quantity) &&
              Number(parseQuantityToDecimal(link.quantity)) > 0),
        )
          ? undefined
          : 'Enter each amount as a number or simple fraction, e.g. 1.5 or 1/2, or leave it blank';
        if ((error ?? ingredientsError) !== undefined && firstInvalid < 0) {
          firstInvalid = index;
        }
        return { ...step, error, ingredientsError };
      });

      if (firstInvalid >= 0) {
        setSteps(validated);
        return false;
      }
      if (overTotalMessages.length > 0) return false;

      // Links to an ingredient no longer on the Ingredients section are left
      // out; the step keeps them in case the ingredient comes back.
      const payload: ReplaceRecipeMethodStepInput[] = steps.map((step) => ({
        instruction: step.instruction.trim(),
        safetyNote: toNotePayload(step.safetyNote),
        tip: toNotePayload(step.tip),
        prepAhead: step.prepAhead,
        ingredients: step.ingredients
          .filter((link) =>
            recipeIngredientsRef.current.some(
              (item) => item.ingredientId === link.ingredientId,
            ),
          )
          .map((link) => ({
            ingredientId: link.ingredientId,
            quantity:
              link.quantity.trim() === ''
                ? null
                : parseQuantityToDecimal(link.quantity),
          })),
      }));

      setSubmitting(true);
      try {
        return await onSubmit(payload);
      } finally {
        setSubmitting(false);
      }
    }, [steps, onSubmit, overTotalMessages]);

    useImperativeHandle(ref, () => ({ submit: runSubmit }), [runSubmit]);

    const canAddStep = steps.every(isStepValid);

    return (
      <TooltipProvider delayDuration={200}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void runSubmit();
          }}
          className="space-y-4"
          noValidate
          aria-labelledby="recipe-method-heading"
        >
          <h2 id="recipe-method-heading" className="text-lg font-semibold">
            Method
          </h2>
          {recipeIngredients.length > 0 && (
            <p className="text-sm text-muted-foreground">
              Each step lists the ingredients it uses. Leave an amount blank to
              use whatever&rsquo;s left of the recipe&rsquo;s total.
            </p>
          )}

          {steps.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No steps yet. Click &ldquo;Add step&rdquo; to start.
            </p>
          ) : (
            <ol className="space-y-3">
              {steps.map((step, index) => (
                <li
                  key={step.rowKey}
                  className="flex items-start gap-2 rounded-md border border-input p-2"
                >
                  <span
                    className="mt-2 w-6 text-center text-sm font-medium text-muted-foreground"
                    aria-hidden
                  >
                    {index + 1}.
                  </span>
                  <div className="flex-1 space-y-1">
                    <textarea
                      ref={(el) => {
                        registerTextarea(step.rowKey, el);
                      }}
                      aria-label={`Step ${String(index + 1)} text`}
                      rows={2}
                      maxLength={RECIPE_INSTRUCTION_MAX_LENGTH}
                      className="flex min-h-16 w-full resize-none overflow-hidden rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      value={step.instruction}
                      onChange={(event) => {
                        updateStep(step.rowKey, event.target.value);
                        autosize(event.currentTarget);
                      }}
                    />
                    {step.error && (
                      <p role="alert" className="text-sm text-destructive">
                        {step.error}
                      </p>
                    )}
                    {step.instruction.length >=
                      RECIPE_INSTRUCTION_MAX_LENGTH - 500 && (
                      <p className="text-right text-xs text-muted-foreground">
                        {step.instruction.length} /{' '}
                        {RECIPE_INSTRUCTION_MAX_LENGTH}
                      </p>
                    )}
                    {recipeIngredients.length > 0 && (
                      <StepIngredientsField
                        stepNumber={index + 1}
                        links={step.ingredients}
                        suggestions={suggestionsByRow.get(step.rowKey) ?? []}
                        recipeIngredients={recipeIngredients}
                        ingredientById={ingredientById}
                        error={step.ingredientsError}
                        onEdit={(edit) => {
                          editIngredients(step.rowKey, edit);
                        }}
                      />
                    )}
                    {NOTE_FIELDS.map(({ field, kind, noun }) => {
                      const note = step[field];
                      if (note === null) return null;
                      const noteKey = `${step.rowKey}:${field}`;
                      return (
                        <StepNoteCallout
                          key={field}
                          kind={kind}
                          action={
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="h-6 w-6"
                              aria-label={`Remove ${noun} from step ${String(index + 1)}`}
                              onClick={() => {
                                setNote(step.rowKey, field, null);
                              }}
                            >
                              ×
                            </Button>
                          }
                        >
                          <textarea
                            ref={(el) => {
                              registerNoteTextarea(noteKey, el);
                            }}
                            aria-label={`Step ${String(index + 1)} ${noun}`}
                            rows={1}
                            maxLength={RECIPE_STEP_NOTE_MAX_LENGTH}
                            className="flex min-h-9 w-full resize-none overflow-hidden rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            value={note}
                            onChange={(event) => {
                              setNote(step.rowKey, field, event.target.value);
                              autosize(event.currentTarget);
                            }}
                          />
                        </StepNoteCallout>
                      );
                    })}
                    <div className="flex flex-wrap items-center gap-1">
                      {NOTE_FIELDS.map(({ field, noun, addLabel }) =>
                        step[field] === null ? (
                          <Button
                            key={field}
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-muted-foreground"
                            aria-label={`Add ${noun} to step ${String(index + 1)}`}
                            onClick={() => {
                              openNote(step.rowKey, field);
                            }}
                          >
                            + {addLabel}
                          </Button>
                        ) : null,
                      )}
                      <select
                        aria-label={`Step ${String(index + 1)} prep ahead`}
                        className="ml-auto h-7 rounded-md border border-input bg-background px-2 text-sm text-muted-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        value={step.prepAhead ?? ''}
                        onChange={(event) => {
                          setPrepAhead(
                            step.rowKey,
                            parsePrepAhead(event.target.value),
                          );
                        }}
                      >
                        {PREP_AHEAD_OPTIONS.map(({ value, label }) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="flex flex-col">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label={`Move step ${String(index + 1)} up`}
                      disabled={index === 0}
                      onClick={() => {
                        moveStep(index, -1);
                      }}
                    >
                      ↑
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label={`Move step ${String(index + 1)} down`}
                      disabled={index === steps.length - 1}
                      onClick={() => {
                        moveStep(index, 1);
                      }}
                    >
                      ↓
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label={`Remove step ${String(index + 1)}`}
                      onClick={() => {
                        removeStep(step.rowKey);
                      }}
                    >
                      ×
                    </Button>
                  </div>
                </li>
              ))}
            </ol>
          )}

          {overTotalMessages.length > 0 && (
            <div role="alert" className="space-y-1 text-sm text-destructive">
              {overTotalMessages.map((message) => (
                <p key={message}>{message}</p>
              ))}
            </div>
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
                    onClick={addStep}
                    disabled={!canAddStep}
                  >
                    Add step
                  </Button>
                </span>
              </TooltipTrigger>
              {/* Rendered only while disabled, so a usable button has no tooltip. */}
              {!canAddStep && (
                <TooltipContent>
                  Fill in each step before adding another
                </TooltipContent>
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
                {submitting ? 'Saving…' : 'Save method'}
              </Button>
            </div>
          </div>
        </form>
      </TooltipProvider>
    );
  },
);

interface StepIngredientsFieldProps {
  stepNumber: number;
  links: readonly DraftStepIngredient[];
  suggestions: readonly StepIngredientSuggestion[];
  recipeIngredients: readonly MethodIngredient[];
  ingredientById: ReadonlyMap<number, MethodIngredient>;
  error?: string;
  onEdit: (
    edit: (links: DraftStepIngredient[]) => DraftStepIngredient[],
  ) => void;
}

// A step's ingredient chips (DEC-99): linked ingredients with an amount field,
// dashed suggestions from the step text that aren't linked yet, and a select
// for any other ingredient on the recipe. A link to an ingredient no longer on
// the Ingredients section is hidden.
function StepIngredientsField({
  stepNumber,
  links,
  suggestions,
  recipeIngredients,
  ingredientById,
  error,
  onEdit,
}: StepIngredientsFieldProps): React.ReactElement {
  const step = String(stepNumber);
  const linkedIds = new Set(links.map((link) => link.ingredientId));
  const visibleLinks = links.filter((link) =>
    ingredientById.has(link.ingredientId),
  );
  const pending = suggestions.filter(
    (suggestion) => !linkedIds.has(suggestion.ingredientId),
  );
  const pendingIds = new Set(pending.map((s) => s.ingredientId));
  const others = recipeIngredients.filter(
    (item) =>
      !linkedIds.has(item.ingredientId) && !pendingIds.has(item.ingredientId),
  );

  const add = (ingredientId: number, quantity: string): void => {
    onEdit((current) =>
      current.some((link) => link.ingredientId === ingredientId)
        ? current
        : [...current, { ingredientId, quantity }],
    );
  };

  return (
    <div className="space-y-1">
      <div
        role="group"
        aria-label={`Step ${step} ingredients`}
        className="flex flex-wrap items-center gap-1.5"
      >
        {visibleLinks.map((link) => {
          const item = ingredientById.get(link.ingredientId);
          if (!item) return null;
          return (
            <span
              key={link.ingredientId}
              className="inline-flex items-center gap-1 rounded-full border border-input bg-background py-0.5 pl-2.5 pr-1 text-xs"
            >
              <span>{item.name}</span>
              <input
                aria-label={`Step ${step} ${item.name} amount`}
                inputMode="decimal"
                placeholder="rest"
                className="h-6 w-14 rounded border border-input bg-background px-1 text-right text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={link.quantity}
                onChange={(event) => {
                  const quantity = sanitizeQuantityInput(event.target.value);
                  onEdit((current) =>
                    current.map((entry) =>
                      entry.ingredientId === link.ingredientId
                        ? { ...entry, quantity }
                        : entry,
                    ),
                  );
                }}
              />
              <span className="text-muted-foreground">{item.unitName}</span>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-5 w-5 rounded-full"
                aria-label={`Remove ${item.name} from step ${step}`}
                onClick={() => {
                  onEdit((current) =>
                    current.filter(
                      (entry) => entry.ingredientId !== link.ingredientId,
                    ),
                  );
                }}
              >
                ×
              </Button>
            </span>
          );
        })}
        {pending.map((suggestion) => {
          const item = ingredientById.get(suggestion.ingredientId);
          if (!item) return null;
          const amount =
            suggestion.quantity === null
              ? ''
              : ` ${suggestion.quantity} ${item.unitName}`;
          return (
            <button
              key={suggestion.ingredientId}
              type="button"
              aria-label={`Add ${item.name} to step ${step}`}
              className="rounded-full border border-dashed border-input px-2.5 py-0.5 text-xs text-muted-foreground hover:border-primary hover:text-foreground"
              onClick={() => {
                add(suggestion.ingredientId, suggestion.quantity ?? '');
              }}
            >
              + {item.name}
              {amount}
            </button>
          );
        })}
        {others.length > 0 && (
          <select
            aria-label={`Add an ingredient to step ${step}`}
            className="h-7 rounded-md border border-input bg-background px-2 text-xs text-muted-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value=""
            onChange={(event) => {
              const ingredientId = Number(event.target.value);
              if (ingredientId > 0) add(ingredientId, '');
            }}
          >
            <option value="">+ Ingredient</option>
            {others.map((item) => (
              <option key={item.ingredientId} value={item.ingredientId}>
                {item.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
