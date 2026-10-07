import type {
  GetRecipeImportResult,
  IngredientListItem,
  IngredientReferences,
  RecipeImportProposal,
  RecipeImportProposedIngredient,
  RecipeReferences,
} from '@loftys-larder/shared';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { TRPCClientError } from '@trpc/client';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  HeaderFields,
  type HeaderFormValues,
} from '@/components/recipe-editor/header-fields.tsx';
import {
  IngredientList,
  type IngredientDraftLine,
  type IngredientPickerOption,
  type ServerLineError,
} from '@/components/recipe-editor/ingredient-list.tsx';
import {
  MethodEditor,
  type MethodDraftStep,
  type MethodEditorHandle,
  type StepNoteField,
} from '@/components/recipe-editor/method-editor.tsx';
import { EstimateMark } from '@/components/recipe-editor/review-badges.tsx';
import type { RecipeSectionHandle } from '@/components/recipe-editor/section-handle.ts';
import { TagFields } from '@/components/recipe-editor/tag-fields.tsx';
import { DiscardImportButton } from '@/components/recipe-import/discard-import-button.tsx';
import { OriginalInput } from '@/components/recipe-import/original-input.tsx';
import { ReaderNotes } from '@/components/recipe-import/reader-notes.tsx';
import type { SearchableComboboxOption } from '@/components/searchable-combobox.tsx';
import { Button } from '@/components/ui/button.tsx';
import { useHealthScoring } from '@/hooks/use-health-scoring.ts';
import { useIsLargeViewport } from '@/hooks/use-is-large-viewport.ts';
import { useImportRecipeDraft } from '@/hooks/use-recipe-draft.ts';
import { getDomainErrorCode } from '@/lib/domain-error.ts';
import { toMethodIngredients } from '@/lib/method-ingredients.ts';
import { buildCreateRecipeFromImportInput } from '@/lib/recipe-import-create-input.ts';
import {
  changedHeaderPaths,
  changedQuantityPaths,
  changedStepPaths,
  clearEstimates,
  hasNutritionEstimate,
  indexEstimates,
  withNutritionEstimates,
  withoutNutritionEstimates,
  type EstimateKind,
} from '@/lib/recipe-import-estimates.ts';
import {
  originalLinesByRow,
  proposalToSections,
  readStoredSections,
  type ImportReviewSectionKey,
  type ImportReviewSections,
} from '@/lib/recipe-import-sections.ts';
import { trpc } from '@/lib/trpc.ts';

const SAVED_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeStyle: 'short',
  timeZone: 'Europe/London',
});

// Nothing is saved per section in Import Review: a section's submit only
// validates, and "Create recipe" writes everything at once (DEC-108).
const acceptSection = (): Promise<boolean> => Promise.resolve(true);

export function RecipeImportReviewPage(): React.ReactElement {
  const params = useParams({ from: '/_authed/recipes/import/$draftId' });
  const draftId = Number.parseInt(params.draftId, 10);
  if (!Number.isInteger(draftId) || draftId <= 0) return <ImportNotFound />;
  return <ImportReview key={draftId} draftId={draftId} />;
}

function ImportReview({ draftId }: { draftId: number }): React.ReactElement {
  const importDraft = useImportRecipeDraft({ draftId });
  const ingredientsQuery = trpc.ingredients.list.useQuery(undefined);
  const referencesQuery = trpc.recipes.references.useQuery();
  const ingredientReferencesQuery = trpc.ingredients.references.useQuery();

  if (importDraft.status === 'not-found') return <ImportNotFound />;
  if (importDraft.status === 'error') {
    return (
      <p role="alert" className="text-sm text-destructive">
        Couldn&rsquo;t load the import. Try again.
      </p>
    );
  }
  const draft = importDraft.draft;
  if (
    !draft ||
    !ingredientsQuery.data ||
    !referencesQuery.data ||
    !ingredientReferencesQuery.data
  ) {
    return (
      <p role="status" className="text-sm">
        Loading import…
      </p>
    );
  }
  if (!draft.proposal) {
    return <UnreadableImport draftId={draftId} discard={importDraft.discard} />;
  }
  return (
    <ImportReviewEditor
      draftId={draftId}
      draft={draft}
      proposal={draft.proposal}
      ingredients={ingredientsQuery.data}
      references={referencesQuery.data}
      ingredientReferences={ingredientReferencesQuery.data}
      savedAt={importDraft.savedAt}
      queueAutosave={importDraft.queueAutosave}
      discard={importDraft.discard}
    />
  );
}

interface ImportReviewEditorProps {
  draftId: number;
  draft: GetRecipeImportResult;
  proposal: RecipeImportProposal;
  ingredients: readonly IngredientListItem[];
  references: RecipeReferences;
  ingredientReferences: IngredientReferences;
  savedAt: number | null;
  queueAutosave: (sectionKey: string, values: unknown) => void;
  discard: () => Promise<void>;
}

function ImportReviewEditor({
  draftId,
  draft,
  proposal,
  ingredients,
  references,
  ingredientReferences,
  savedAt,
  queueAutosave,
  discard,
}: ImportReviewEditorProps): React.ReactElement {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const healthScoring = useHealthScoring();
  const createMutation = trpc.recipeImports.createRecipe.useMutation();
  const isLarge = useIsLargeViewport();

  // The proposal is mapped into the editor's sections once, and what the cook
  // saved so far is laid over it. Later renders never re-map (DEC-108).
  const [initial] = useState<ImportReviewSections>(() =>
    readStoredSections(
      proposalToSections(proposal, toIngredientLookup(ingredients)),
      draft.draftData.fields,
    ),
  );
  const originalLines = useMemo(() => originalLinesByRow(proposal), [proposal]);

  // The latest value of every section, for building the create input.
  const sectionsRef = useRef<ImportReviewSections>(initial);
  const [estimates, setEstimates] = useState(initial.estimates);
  const [newIngredients, setNewIngredients] = useState(initial.newIngredients);
  const [newSource, setNewSource] = useState(initial.newSource);
  const [editedLines, setEditedLines] = useState<IngredientDraftLine[] | null>(
    null,
  );
  const [ingredientErrors, setIngredientErrors] = useState<ServerLineError[]>(
    [],
  );
  const [topLevelError, setTopLevelError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const validatedHeaderRef = useRef<HeaderFormValues | null>(null);

  const headerRef = useRef<RecipeSectionHandle>(null);
  const ingredientsRef = useRef<RecipeSectionHandle>(null);
  const methodRef = useRef<MethodEditorHandle>(null);
  const tagsRef = useRef<RecipeSectionHandle>(null);

  const save = useCallback(
    <K extends ImportReviewSectionKey>(
      key: K,
      value: ImportReviewSections[K],
    ) => {
      sectionsRef.current = { ...sectionsRef.current, [key]: value };
      queueAutosave(key, value);
    },
    [queueAutosave],
  );

  const setMarks = useCallback(
    (next: ImportReviewSections['estimates']) => {
      if (next === sectionsRef.current.estimates) return;
      save('estimates', next);
      setEstimates(next);
    },
    [save],
  );

  const clearMarks = useCallback(
    (paths: ReadonlySet<string>) => {
      setMarks(clearEstimates(sectionsRef.current.estimates, paths));
    },
    [setMarks],
  );

  const handleHeaderChange = useCallback(
    (values: HeaderFormValues) => {
      const before = sectionsRef.current.header;
      const after = { ...values };
      save('header', after);
      clearMarks(changedHeaderPaths(before, after));
    },
    [save, clearMarks],
  );

  const handleHeaderValidated = useCallback(
    (values: HeaderFormValues): Promise<boolean> => {
      validatedHeaderRef.current = values;
      return Promise.resolve(true);
    },
    [],
  );

  const handleSourceChange = useCallback(
    (name: string | null) => {
      save('newSource', name);
      setNewSource(name);
    },
    [save],
  );

  const handleLinesChange = useCallback(
    (lines: IngredientDraftLine[]) => {
      const before = sectionsRef.current.ingredients;
      save('ingredients', lines);
      setEditedLines(lines);
      clearMarks(changedQuantityPaths(before, lines));
    },
    [save, clearMarks],
  );

  const handleStepsChange = useCallback(
    (steps: MethodDraftStep[]) => {
      const before = sectionsRef.current.method;
      save('method', steps);
      clearMarks(changedStepPaths(before, steps));
    },
    [save, clearMarks],
  );

  const handleTagsChange = useCallback(
    (names: string[]) => {
      save('tags', names);
    },
    [save],
  );

  const setProposed = useCallback(
    (next: RecipeImportProposedIngredient[]) => {
      save('newIngredients', next);
      setNewIngredients(next);
    },
    [save],
  );

  const changeProposed = useCallback(
    (
      key: string,
      patch: Partial<Omit<RecipeImportProposedIngredient, 'key'>>,
    ) => {
      setProposed(
        sectionsRef.current.newIngredients.map((ingredient) =>
          ingredient.key === key ? { ...ingredient, ...patch } : ingredient,
        ),
      );
    },
    [setProposed],
  );

  // A name already proposed reuses that proposal rather than making a second
  // ingredient with the same name.
  const proposeIngredient = useCallback(
    (name: string): string => {
      const existing = sectionsRef.current.newIngredients;
      const trimmed = name.trim();
      const match = existing.find(
        (ingredient) =>
          ingredient.name.trim().toLowerCase() === trimmed.toLowerCase(),
      );
      if (match) return match.key;
      const key = nextProposedKey(existing);
      setProposed([
        ...existing,
        {
          key,
          name: trimmed,
          categoryId: null,
          defaultUnitId: null,
          isPlant: false,
          averageShelfLifeDays: null,
        },
      ]);
      return key;
    },
    [setProposed],
  );

  const handleProposedReplaced = useCallback(
    (newKey: string, ingredientId: number, stillUsed: boolean) => {
      if (!stillUsed) methodRef.current?.remapIngredient(newKey, ingredientId);
    },
    [],
  );

  const handleNutritionEstimated = useCallback(
    (checked: boolean) => {
      const current = sectionsRef.current.estimates;
      setMarks(
        checked
          ? withNutritionEstimates(current, sectionsRef.current.header)
          : withoutNutritionEstimates(current),
      );
    },
    [setMarks],
  );

  const searchIngredients = useCallback(
    async (query: string): Promise<readonly IngredientPickerOption[]> => {
      const trimmed = query.trim();
      const result = await utils.ingredients.list.fetch(
        trimmed ? { search: trimmed } : undefined,
      );
      return [...toIngredientLookup(result).values()];
    },
    [utils.ingredients.list],
  );

  const searchTags = useCallback(
    async (query: string): Promise<readonly SearchableComboboxOption[]> => {
      const tags = await utils.recipes.listTags.fetch();
      const lowered = query.trim().toLowerCase();
      return tags
        .filter((tag) => tag.name.toLowerCase().includes(lowered))
        .map((tag) => ({ id: tag.id, label: tag.name }));
    },
    [utils.recipes.listTags],
  );

  const proposedByKey = useMemo(
    () =>
      new Map(newIngredients.map((ingredient) => [ingredient.key, ingredient])),
    [newIngredients],
  );
  const unitName = useCallback(
    (unitId: number | null): string =>
      ingredientReferences.units.find((unit) => unit.id === unitId)?.name ?? '',
    [ingredientReferences.units],
  );
  const methodIngredients = useMemo(
    () =>
      toMethodIngredients(editedLines ?? initial.ingredients, {
        byKey: proposedByKey,
        unitName,
      }),
    [editedLines, initial.ingredients, proposedByKey, unitName],
  );

  const notes = useMemo(
    () => estimateNotes(indexEstimates(estimates)),
    [estimates],
  );

  async function handleCreate(): Promise<void> {
    setCreating(true);
    setTopLevelError(null);
    setIngredientErrors([]);
    try {
      for (const section of [headerRef, ingredientsRef, methodRef, tagsRef]) {
        const valid = (await section.current?.submit()) ?? false;
        if (!valid) {
          setTopLevelError(
            'Some fields need attention before the recipe can be created.',
          );
          return;
        }
      }
      const sections: ImportReviewSections = {
        ...sectionsRef.current,
        header: validatedHeaderRef.current ?? sectionsRef.current.header,
      };
      const repeated = repeatedProposedName(sections);
      if (repeated !== null) {
        setTopLevelError(
          `Two new ingredients are called “${repeated}”. Rename one, or use an existing ingredient.`,
        );
        return;
      }
      const result = await createMutation.mutateAsync(
        buildCreateRecipeFromImportInput(draftId, sections),
      );
      await Promise.all([
        utils.recipeImports.list.invalidate(),
        utils.recipes.list.invalidate(),
        utils.ingredients.list.invalidate(),
        utils.recipes.references.invalidate(),
        utils.recipes.listTags.invalidate(),
      ]);
      // In the background, with no further step (DEC-112).
      healthScoring.scoreAfterSave(result.recipeId);
      await navigate({
        to: '/recipes/$recipeId',
        params: { recipeId: String(result.recipeId) },
      });
    } catch (err) {
      showCreateError(err);
    } finally {
      setCreating(false);
    }
  }

  function showCreateError(err: unknown): void {
    const code = getDomainErrorCode(err);
    const cause = readCause(err);
    const lines = sectionsRef.current.ingredients;
    if (code === 'INGREDIENT_NAME_TAKEN' && typeof cause?.newKey === 'string') {
      const index = lines.findIndex((line) => line.newKey === cause.newKey);
      if (index >= 0) {
        setIngredientErrors([
          {
            index,
            message:
              'You already have an ingredient with this name. Rename it, or use the existing one.',
          },
        ]);
        setTopLevelError('Check the ingredient marked above.');
        return;
      }
    }
    if (
      (code === 'RECIPE_INGREDIENT_UNIT_MISMATCH' ||
        code === 'RECIPE_INGREDIENT_NOT_FOUND') &&
      typeof cause?.ingredientId === 'number'
    ) {
      const index = lines.findIndex(
        (line) =>
          line.newKey === undefined &&
          line.ingredient?.id === cause.ingredientId,
      );
      if (index >= 0) {
        setIngredientErrors([
          {
            index,
            message:
              code === 'RECIPE_INGREDIENT_UNIT_MISMATCH'
                ? 'This ingredient’s unit has changed. Pick it again and check the quantity.'
                : 'Ingredient not available',
          },
        ]);
        setTopLevelError('Check the ingredient marked above.');
        return;
      }
    }
    if (code === 'RECIPE_STEP_AMOUNT_EXCEEDS_TOTAL') {
      setTopLevelError('The step amounts add up to more than the recipe uses.');
      return;
    }
    if (isNotFoundError(err)) {
      setTopLevelError('This import has already been finished or discarded.');
      return;
    }
    setTopLevelError('Couldn’t create the recipe. Try again.');
  }

  async function handleDiscard(): Promise<void> {
    await discard();
    await navigate({ to: '/recipes/import' });
  }

  return (
    <section className="mx-auto max-w-6xl space-y-6">
      <header className="space-y-2">
        <p className="text-sm">
          <Link
            to="/recipes/import"
            className="text-muted-foreground hover:underline"
          >
            ← Imports
          </Link>
        </p>
        <h1 className="text-2xl font-semibold">Review import</h1>
        <p className="text-sm text-muted-foreground">
          Check the proposal against the original and correct anything
          that&rsquo;s wrong. Nothing is added to your recipes until you create
          it.
        </p>
      </header>

      <ReaderNotes notes={proposal.notes} />

      <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <OriginalInput
          input={proposal.input}
          images={draft.images}
          collapsible={!isLarge}
        />

        <div className="min-w-0 space-y-8">
          <HeaderFields
            ref={headerRef}
            mode="import"
            defaultValues={initial.header}
            sources={references.sources}
            onSubmit={handleHeaderValidated}
            onValuesChange={handleHeaderChange}
            fieldNotes={notes.header}
            proposedSourceName={newSource}
            onProposedSourceNameChange={handleSourceChange}
            nutritionEstimated={{
              checked: hasNutritionEstimate(estimates),
              onChange: handleNutritionEstimated,
            }}
            hideSaveButton
          />

          <IngredientList
            ref={ingredientsRef}
            initialLines={[]}
            initialDraftLines={initial.ingredients}
            prepTypes={references.prepTypes}
            searchIngredients={searchIngredients}
            references={ingredientReferences}
            onSubmit={acceptSection}
            onLinesChange={handleLinesChange}
            serverErrors={ingredientErrors}
            proposedIngredients={proposedByKey}
            onProposedIngredientChange={changeProposed}
            proposeIngredient={proposeIngredient}
            onProposedReplaced={handleProposedReplaced}
            originalLines={originalLines}
            quantityNotes={notes.quantity}
            hideSaveButton
          />

          <MethodEditor
            ref={methodRef}
            initialSteps={[]}
            initialDraftSteps={initial.method}
            onSubmit={acceptSection}
            onStepsChange={handleStepsChange}
            recipeIngredients={methodIngredients}
            stepNotes={notes.steps}
            hideSaveButton
          />

          <TagFields
            ref={tagsRef}
            initialNames={initial.tags}
            searchTags={searchTags}
            onSubmit={acceptSection}
            onNamesChange={handleTagsChange}
            hideSaveButton
          />

          <div className="space-y-3 border-t pt-6">
            {topLevelError && (
              <p role="alert" className="text-sm text-destructive">
                {topLevelError}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-end gap-3">
              {savedAt !== null && (
                <p className="mr-auto text-xs text-muted-foreground">
                  Saved {SAVED_FORMAT.format(new Date(savedAt))}
                </p>
              )}
              <DiscardImportButton
                name={null}
                onConfirm={handleDiscard}
                disabled={creating}
              />
              <Button
                type="button"
                disabled={creating}
                onClick={() => {
                  void handleCreate();
                }}
              >
                {creating ? 'Creating…' : 'Create recipe'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function toIngredientLookup(
  rows: readonly IngredientListItem[],
): Map<number, IngredientPickerOption> {
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        label: row.name,
        defaultUnitId: row.defaultUnitId,
        unitName: row.defaultUnitName,
      },
    ]),
  );
}

function nextProposedKey(
  existing: readonly RecipeImportProposedIngredient[],
): string {
  const taken = new Set(existing.map((ingredient) => ingredient.key));
  let n = existing.length + 1;
  while (taken.has(`c${String(n)}`)) n += 1;
  return `c${String(n)}`;
}

// The create input refuses two new ingredients with the same name; catch it
// here so the cook gets a sentence rather than a validation dump.
function repeatedProposedName(sections: ImportReviewSections): string | null {
  const used = new Set(
    sections.ingredients.flatMap((line) =>
      line.newKey === undefined ? [] : [line.newKey],
    ),
  );
  const seen = new Set<string>();
  for (const ingredient of sections.newIngredients) {
    if (!used.has(ingredient.key)) continue;
    const name = ingredient.name.trim().toLowerCase();
    if (seen.has(name)) return ingredient.name.trim();
    seen.add(name);
  }
  return null;
}

interface EstimateNotes {
  header: Partial<Record<keyof HeaderFormValues, ReactNode>>;
  quantity: ReadonlyMap<string, ReactNode>;
  steps: ReadonlyMap<string, Partial<Record<StepNoteField, ReactNode>>>;
}

const QUANTITY_PATH = /^ingredient:(.+)\.quantity$/;
const STEP_PATH = /^step:([^.]+)\.(safetyNote|tip|prepAhead|ingredients)$/;

function estimateNotes(
  marks: ReadonlyMap<string, EstimateKind>,
): EstimateNotes {
  const header: EstimateNotes['header'] = {};
  const quantity = new Map<string, ReactNode>();
  const steps = new Map<string, Partial<Record<StepNoteField, ReactNode>>>();
  for (const [path, kind] of marks) {
    const mark = <EstimateMark kind={kind} />;
    if (path.startsWith('header.')) {
      header[path.slice('header.'.length) as keyof HeaderFormValues] = mark;
      continue;
    }
    const row = QUANTITY_PATH.exec(path);
    if (row?.[1]) {
      quantity.set(row[1], mark);
      continue;
    }
    const step = STEP_PATH.exec(path);
    if (step?.[1] && step[2]) {
      steps.set(step[1], {
        ...steps.get(step[1]),
        [step[2] as StepNoteField]: mark,
      });
    }
  }
  return { header, quantity, steps };
}

function readCause(err: unknown): Record<string, unknown> | null {
  if (!(err instanceof TRPCClientError)) return null;
  const cause = (err.shape as { data?: { cause?: unknown } } | undefined)?.data
    ?.cause;
  return typeof cause === 'object' && cause !== null
    ? (cause as Record<string, unknown>)
    : null;
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof TRPCClientError)) return false;
  const data = (error as { data?: { code?: unknown } }).data;
  return data?.code === 'NOT_FOUND';
}

function UnreadableImport({
  draftId,
  discard,
}: {
  draftId: number;
  discard: () => Promise<void>;
}): React.ReactElement {
  const navigate = useNavigate();
  return (
    <section className="mx-auto max-w-3xl space-y-3">
      <h1 className="text-2xl font-semibold">
        This import can&rsquo;t be opened
      </h1>
      <p className="text-sm text-muted-foreground">
        Import {draftId} no longer holds a proposal to review. Discard it and
        import the recipe again.
      </p>
      <div className="flex gap-3">
        <DiscardImportButton
          name={null}
          onConfirm={async () => {
            await discard();
            await navigate({ to: '/recipes/import' });
          }}
        />
        <Button asChild variant="ghost">
          <Link to="/recipes/import">Back to imports</Link>
        </Button>
      </div>
    </section>
  );
}

function ImportNotFound(): React.ReactElement {
  return (
    <section className="mx-auto max-w-3xl space-y-3">
      <h1 className="text-2xl font-semibold">Import not found</h1>
      <p className="text-sm">
        <Link to="/recipes/import" className="hover:underline">
          ← Back to imports
        </Link>
      </p>
    </section>
  );
}
