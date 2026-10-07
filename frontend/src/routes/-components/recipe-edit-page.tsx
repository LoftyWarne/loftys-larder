import type {
  CreateIngredientInput,
  Recipe,
  RecipeReferenceItem,
  RecipeReferences,
  ReplaceRecipeIngredientsLine,
  ReplaceRecipeMethodStepInput,
  UpdateRecipeHeaderInput,
} from '@loftys-larder/shared';
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
} from '@tanstack/react-router';
import { TRPCClientError } from '@trpc/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  ServingVariationFields,
  type ServingVariationFieldsValues,
  type RecipePickerOption,
} from '@/components/recipe-editor/serving-variation-fields.tsx';
import {
  HeaderFields,
  type HeaderFormValues,
} from '@/components/recipe-editor/header-fields.tsx';
import { ImageUploader } from '@/components/recipe-editor/image-uploader.tsx';
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
} from '@/components/recipe-editor/method-editor.tsx';
import type { RecipeSectionHandle } from '@/components/recipe-editor/section-handle.ts';
import { TagFields } from '@/components/recipe-editor/tag-fields.tsx';
import type { SearchableComboboxOption } from '@/components/searchable-combobox.tsx';
import { Button } from '@/components/ui/button.tsx';
import { useHealthScoring } from '@/hooks/use-health-scoring.ts';
import { useRecipeDraft } from '@/hooks/use-recipe-draft.ts';
import { getDomainErrorCode } from '@/lib/domain-error.ts';
import { toMethodIngredients } from '@/lib/method-ingredients.ts';
import { trimTrailingZeros } from '@/lib/quantity-input.ts';
import { trpc } from '@/lib/trpc.ts';

type Patch = UpdateRecipeHeaderInput['patch'];

interface EditorDraftShape {
  header: HeaderFormValues;
  ingredients: IngredientDraftLine[];
  method: MethodDraftStep[];
  tags: string[];
}

export function RecipeEditPage(): React.ReactElement {
  const params = useParams({ from: '/_authed/recipes/$recipeId/edit' });
  const recipeId = Number.parseInt(params.recipeId, 10);
  const idIsValid = Number.isInteger(recipeId) && recipeId > 0;

  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const healthScoring = useHealthScoring();
  const recipeQuery = trpc.recipes.get.useQuery(
    { id: recipeId },
    { enabled: idIsValid, retry: false },
  );
  const referencesQuery = trpc.recipes.references.useQuery();
  const ingredientReferencesQuery = trpc.ingredients.references.useQuery();
  const credentialsQuery = trpc.uploads.getRecipeImageCredentials.useQuery(
    undefined,
    { enabled: false },
  );

  const createIngredientMutation = trpc.ingredients.create.useMutation();
  const createSourceMutation = trpc.recipes.createSource.useMutation();
  const updateHeader = trpc.recipes.updateHeader.useMutation();
  const replaceIngredients = trpc.recipes.replaceIngredients.useMutation();
  const replaceMethod = trpc.recipes.replaceMethod.useMutation();
  const replaceTags = trpc.recipes.replaceTags.useMutation();
  const setServingVariationFields =
    trpc.recipes.setServingVariationFields.useMutation();

  const [headerSavedKey, setHeaderSavedKey] = useState<number | undefined>();
  const [ingredientsSavedKey, setIngredientsSavedKey] = useState<
    number | undefined
  >();
  const [methodSavedKey, setMethodSavedKey] = useState<number | undefined>();
  const [tagsSavedKey, setTagsSavedKey] = useState<number | undefined>();
  const [imageSavedKey, setImageSavedKey] = useState<number | undefined>();
  const [servingVariationSavedKey, setServingVariationSavedKey] = useState<
    number | undefined
  >();
  const [servingVariationError, setServingVariationError] = useState<
    string | null
  >(null);
  const [ingredientErrors, setIngredientErrors] = useState<ServerLineError[]>(
    [],
  );
  const [topLevelError, setTopLevelError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  // The Ingredients section's lines as last edited, so the method editor can
  // offer them to steps before they're saved. `null` until the first edit.
  const [editedIngredientLines, setEditedIngredientLines] = useState<
    IngredientDraftLine[] | null
  >(null);

  const headerRef = useRef<RecipeSectionHandle>(null);
  const servingVariationRef = useRef<RecipeSectionHandle>(null);
  const ingredientsRef = useRef<RecipeSectionHandle>(null);
  const methodRef = useRef<MethodEditorHandle>(null);
  const tagsRef = useRef<RecipeSectionHandle>(null);

  const recipe = recipeQuery.data ?? null;

  const serverDefaults = useMemo<EditorDraftShape | null>(() => {
    if (!recipe) return null;
    return {
      header: toHeaderDefaults(recipe),
      ingredients: recipe.ingredients.map((line) => ({
        ingredient: {
          id: line.ingredientId,
          label: line.ingredientName,
          defaultUnitId: line.unitId,
          unitName: line.unitName,
        },
        // DB pads to scale (`0.25` → `0.250`); show no more precision than
        // the value needs.
        quantity: trimTrailingZeros(line.quantity),
        prepTypeId: line.prepTypeId,
        isOptional: line.isOptional,
      })),
      method: recipe.method.map((step) => ({
        instruction: step.instruction,
        safetyNote: step.safetyNote,
        tip: step.tip,
        prepAhead: step.prepAhead,
        ingredients: step.ingredients.map((link) => ({
          ingredientId: link.ingredientId,
          quantity:
            link.quantity === null ? '' : trimTrailingZeros(link.quantity),
        })),
        followsText: step.ingredients.length === 0,
      })),
      tags: recipe.tags.map((tag) => tag.name),
    };
  }, [recipe]);

  const draft = useRecipeDraft<EditorDraftShape>({
    recipeId: idIsValid ? recipeId : null,
    enabled: idIsValid && recipe !== null,
    serverDefaults: serverDefaults ?? EMPTY_DRAFT_SHAPE,
  });

  // A header draft saved before a field existed lacks that key. Fill it from
  // the server, or the form would load it blank and the next save would
  // clear the stored value.
  const headerDefaults = useMemo<HeaderFormValues>(
    () => ({
      ...(serverDefaults ?? EMPTY_DRAFT_SHAPE).header,
      ...draft.mergedDefaults.header,
    }),
    [serverDefaults, draft.mergedDefaults.header],
  );

  const methodIngredients = useMemo(
    () =>
      toMethodIngredients(
        editedIngredientLines ?? draft.mergedDefaults.ingredients,
      ),
    [editedIngredientLines, draft.mergedDefaults.ingredients],
  );

  // Arriving from "Save & continue" on a new recipe, the URL carries a hash
  // pointing at the section to start on. The target only exists once the recipe
  // has loaded and its sections render, so scroll then — once.
  const { hash } = useLocation();
  const recipeLoaded = recipe !== null && draft.isReady;
  const scrolledRef = useRef(false);
  useEffect(() => {
    if (scrolledRef.current || !hash || !recipeLoaded) return;
    const target = document.getElementById(hash);
    if (!target) return;
    scrolledRef.current = true;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [hash, recipeLoaded]);

  const searchIngredients = useCallback(
    async (query: string): Promise<readonly IngredientPickerOption[]> => {
      const trimmed = query.trim();
      const result = await utils.ingredients.list.fetch(
        trimmed ? { search: trimmed } : undefined,
      );
      return result.map((row) => ({
        id: row.id,
        label: row.name,
        defaultUnitId: row.defaultUnitId,
        unitName: row.defaultUnitName,
      }));
    },
    [utils.ingredients.list],
  );

  const createIngredient = useCallback(
    async (values: CreateIngredientInput): Promise<IngredientPickerOption> => {
      const created = await createIngredientMutation.mutateAsync(values);
      await utils.ingredients.list.invalidate();
      return {
        id: created.id,
        label: created.name,
        defaultUnitId: created.defaultUnitId,
        unitName: created.defaultUnitName,
      };
    },
    [createIngredientMutation, utils.ingredients.list],
  );

  const createSource = useCallback(
    async (name: string): Promise<RecipeReferenceItem> => {
      const created = await createSourceMutation.mutateAsync({ name });
      await utils.recipes.references.invalidate();
      return created;
    },
    [createSourceMutation, utils.recipes.references],
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

  const searchBases = useCallback(
    async (query: string): Promise<readonly RecipePickerOption[]> => {
      const trimmed = query.trim();
      const result = await utils.recipes.list.fetch({
        search: trimmed || undefined,
        isBase: true,
        includePickerHidden: true,
      });
      return result.items
        .filter((row) => row.id !== recipeId)
        .map((row) => ({ id: row.id, label: row.name }));
    },
    [utils.recipes.list, recipeId],
  );

  if (!idIsValid) return <NotFound />;
  if (recipeQuery.isLoading)
    return (
      <p role="status" className="text-sm">
        Loading recipe…
      </p>
    );
  if (recipeQuery.error) {
    if (isNotFoundError(recipeQuery.error)) return <NotFound />;
    return (
      <p role="alert" className="text-sm text-destructive">
        Could not load recipe: {recipeQuery.error.message}
      </p>
    );
  }
  if (!recipe || !serverDefaults) return <NotFound />;
  if (!draft.isReady) {
    return (
      <p role="status" className="text-sm">
        Loading recipe…
      </p>
    );
  }

  const references: RecipeReferences = referencesQuery.data ?? {
    units: [],
    prepTypes: [],
    sources: [],
  };
  const defaults = draft.mergedDefaults;
  const serverHeader = serverDefaults.header;

  async function invalidate(): Promise<void> {
    await utils.recipes.get.invalidate({ id: recipeId });
  }

  async function handleHeaderSubmit(
    values: HeaderFormValues,
  ): Promise<boolean> {
    setTopLevelError(null);
    const patch = diffHeader(serverHeader, values);
    if (Object.keys(patch).length === 0) {
      setHeaderSavedKey(Date.now());
      draft.clearSection('header');
      return true;
    }
    try {
      await updateHeader.mutateAsync({ id: recipeId, patch });
      await invalidate();
      setHeaderSavedKey(Date.now());
      draft.clearSection('header');
      return true;
    } catch (err) {
      setTopLevelError(extractMessage(err));
      return false;
    }
  }

  async function handleIngredientsSubmit(
    lines: ReplaceRecipeIngredientsLine[],
  ): Promise<boolean> {
    setTopLevelError(null);
    setIngredientErrors([]);
    try {
      await replaceIngredients.mutateAsync({ recipeId, lines });
      await invalidate();
      setIngredientsSavedKey(Date.now());
      draft.clearSection('ingredients');
      return true;
    } catch (err) {
      const lineError = mapIngredientLineError(err, lines);
      if (lineError) {
        setIngredientErrors([lineError]);
      } else {
        setTopLevelError(extractMessage(err));
      }
      return false;
    }
  }

  async function handleMethodSubmit(
    steps: ReplaceRecipeMethodStepInput[],
  ): Promise<boolean> {
    setTopLevelError(null);
    try {
      await replaceMethod.mutateAsync({ recipeId, steps });
      await invalidate();
      setMethodSavedKey(Date.now());
      draft.clearSection('method');
      return true;
    } catch (err) {
      setTopLevelError(
        getDomainErrorCode(err) === 'RECIPE_STEP_AMOUNT_EXCEEDS_TOTAL'
          ? 'The step amounts add up to more than the saved recipe uses. Save the ingredients first, then the method.'
          : extractMessage(err),
      );
      return false;
    }
  }

  async function handleTagsSubmit(names: string[]): Promise<boolean> {
    setTopLevelError(null);
    try {
      await replaceTags.mutateAsync({ recipeId, names });
      await Promise.all([invalidate(), utils.recipes.listTags.invalidate()]);
      setTagsSavedKey(Date.now());
      draft.clearSection('tags');
      return true;
    } catch (err) {
      setTopLevelError(extractMessage(err));
      return false;
    }
  }

  async function handleImageChange(secureUrl: string | null): Promise<void> {
    setTopLevelError(null);
    try {
      await updateHeader.mutateAsync({
        id: recipeId,
        patch: { imageUrl: secureUrl },
      });
      await invalidate();
      setImageSavedKey(Date.now());
    } catch (err) {
      setTopLevelError(extractMessage(err));
    }
  }

  async function handleServingVariationSubmit(
    changes: Partial<ServingVariationFieldsValues>,
  ): Promise<boolean> {
    setServingVariationError(null);
    try {
      await setServingVariationFields.mutateAsync({ id: recipeId, ...changes });
      await invalidate();
      setServingVariationSavedKey(Date.now());
      return true;
    } catch (err) {
      setServingVariationError(mapServingVariationError(err));
      return false;
    }
  }

  // Flush every section, then return to the recipe view. Each section runs its
  // own validation + save and reports success. We stop at the first failure so
  // its error stays on screen — the sections share one top-level error slot, so
  // letting a later section run would clear the failing one's message. Earlier
  // sections have already saved; navigation only happens once every one passes.
  async function handleSaveAndFinish(): Promise<void> {
    setFinishing(true);
    try {
      const sections = [
        headerRef,
        servingVariationRef,
        ingredientsRef,
        methodRef,
        tagsRef,
      ];
      for (const section of sections) {
        const saved = (await section.current?.submit()) ?? false;
        if (!saved) return;
      }
      // In the background: the cook doesn't wait for a score (DEC-112).
      healthScoring.scoreAfterSave(recipeId);
      await navigate({
        to: '/recipes/$recipeId',
        params: { recipeId: String(recipeId) },
      });
    } finally {
      setFinishing(false);
    }
  }

  async function fetchCredentials() {
    const data = await credentialsQuery.refetch();
    if (!data.data) {
      throw new Error('Could not get upload credentials');
    }
    return data.data;
  }

  return (
    <section className="mx-auto max-w-3xl space-y-8">
      <header className="space-y-2">
        <p className="text-sm">
          <Link
            to="/recipes/$recipeId"
            params={{ recipeId: String(recipeId) }}
            className="text-muted-foreground hover:underline"
          >
            ← Back to recipe
          </Link>
        </p>
        <h1 className="text-2xl font-semibold">Editing {recipe.name}</h1>
      </header>

      {draft.draftPresent && (
        <div
          role="status"
          className="flex items-center justify-between rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          <span>Unsaved draft restored.</span>
          <button
            type="button"
            onClick={draft.discardDraft}
            className="text-sm font-medium underline hover:no-underline"
          >
            Discard draft
          </button>
        </div>
      )}

      {topLevelError && (
        <p role="alert" className="text-sm text-destructive">
          {topLevelError}
        </p>
      )}

      <HeaderFields
        ref={headerRef}
        mode="edit"
        defaultValues={headerDefaults}
        sources={references.sources}
        createSource={createSource}
        onSubmit={handleHeaderSubmit}
        onValuesChange={(values) => {
          draft.queueAutosave('header', values);
        }}
        savedNoticeKey={headerSavedKey}
      />

      <ServingVariationFields
        ref={servingVariationRef}
        initial={{
          isBase: recipe.isBase,
          baseRecipeId: recipe.baseRecipeId,
        }}
        baseRecipePartner={
          recipe.baseRecipeId !== null && recipe.baseRecipeName !== null
            ? {
                id: recipe.baseRecipeId,
                name: recipe.baseRecipeName,
                isDeleted: recipe.baseRecipeIsDeleted ?? false,
              }
            : null
        }
        searchBases={searchBases}
        onSubmit={handleServingVariationSubmit}
        savedNoticeKey={servingVariationSavedKey}
        errorMessage={servingVariationError}
      />

      <IngredientList
        ref={ingredientsRef}
        initialLines={recipe.ingredients}
        initialDraftLines={defaults.ingredients}
        prepTypes={references.prepTypes}
        searchIngredients={searchIngredients}
        references={ingredientReferencesQuery.data}
        createIngredient={createIngredient}
        onSubmit={handleIngredientsSubmit}
        onLinesChange={(lines) => {
          setEditedIngredientLines(lines);
          draft.queueAutosave('ingredients', lines);
        }}
        serverErrors={ingredientErrors}
        savedNoticeKey={ingredientsSavedKey}
      />

      <MethodEditor
        ref={methodRef}
        initialSteps={recipe.method}
        initialDraftSteps={defaults.method}
        onSubmit={handleMethodSubmit}
        onStepsChange={(steps) => {
          draft.queueAutosave('method', steps);
        }}
        savedNoticeKey={methodSavedKey}
        recipeIngredients={methodIngredients}
      />

      <TagFields
        ref={tagsRef}
        initialNames={serverDefaults.tags}
        initialDraftNames={parseDraftTags(defaults.tags)}
        searchTags={searchTags}
        onSubmit={handleTagsSubmit}
        onNamesChange={(names) => {
          draft.queueAutosave('tags', names);
        }}
        savedNoticeKey={tagsSavedKey}
      />

      <ImageUploader
        imageUrl={recipe.imageUrl}
        getCredentials={fetchCredentials}
        onUploaded={handleImageChange}
      />
      {imageSavedKey !== undefined && (
        <p
          key={imageSavedKey}
          role="status"
          className="text-sm text-emerald-600"
        >
          Image saved.
        </p>
      )}

      <div className="flex items-center justify-end gap-3 border-t pt-6">
        <Link
          to="/recipes/$recipeId"
          params={{ recipeId: String(recipeId) }}
          className="text-sm text-muted-foreground hover:underline"
        >
          Cancel
        </Link>
        <Button
          type="button"
          onClick={() => {
            void handleSaveAndFinish();
          }}
          disabled={finishing}
        >
          {finishing ? 'Saving…' : 'Save & Finish'}
        </Button>
      </div>
    </section>
  );
}

const EMPTY_DRAFT_SHAPE: EditorDraftShape = {
  header: {
    name: '',
    description: null,
    imageUrl: null,
    baseServings: 1,
    activeTimeMins: null,
    totalTimeMins: null,
    estimatedCostPerServing: null,
    sourceId: null,
    sourceUrl: null,
    sourceDetail: null,
    caloriesPerServing: null,
    proteinPerServing: null,
    carbsPerServing: null,
    fatPerServing: null,
    saturatedFatPerServing: null,
    fibrePerServing: null,
    sugarPerServing: null,
    saltPerServing: null,
    nutritionIsEstimated: false,
    isBase: false,
  },
  ingredients: [],
  method: [],
  tags: [],
};

function toHeaderDefaults(recipe: Recipe): HeaderFormValues {
  return {
    name: recipe.name,
    description: recipe.description,
    imageUrl: recipe.imageUrl,
    baseServings: recipe.baseServings,
    activeTimeMins: recipe.activeTimeMins,
    totalTimeMins: recipe.totalTimeMins,
    estimatedCostPerServing: recipe.estimatedCostPerServing,
    sourceId: recipe.sourceId,
    sourceUrl: recipe.sourceUrl,
    sourceDetail: recipe.sourceDetail,
    caloriesPerServing: recipe.caloriesPerServing,
    proteinPerServing: recipe.proteinPerServing,
    carbsPerServing: recipe.carbsPerServing,
    fatPerServing: recipe.fatPerServing,
    saturatedFatPerServing: recipe.saturatedFatPerServing,
    fibrePerServing: recipe.fibrePerServing,
    sugarPerServing: recipe.sugarPerServing,
    saltPerServing: recipe.saltPerServing,
    nutritionIsEstimated: recipe.nutritionIsEstimated,
    isBase: recipe.isBase,
  };
}

const PATCH_KEYS = [
  'name',
  'description',
  'imageUrl',
  'baseServings',
  'activeTimeMins',
  'totalTimeMins',
  'estimatedCostPerServing',
  'sourceId',
  'sourceUrl',
  'sourceDetail',
  'caloriesPerServing',
  'proteinPerServing',
  'carbsPerServing',
  'fatPerServing',
  'saturatedFatPerServing',
  'fibrePerServing',
  'sugarPerServing',
  'saltPerServing',
  'nutritionIsEstimated',
] as const satisfies readonly (keyof Patch & keyof HeaderFormValues)[];

function diffHeader(before: HeaderFormValues, after: HeaderFormValues): Patch {
  const patch: Patch = {};
  for (const key of PATCH_KEYS) {
    const a = before[key];
    const b = after[key];
    if (a !== b) {
      (patch as Record<string, unknown>)[key] = b;
    }
  }
  return patch;
}

// Drafts are stored as untyped JSON; anything that isn't a list of strings
// (a corrupt row) falls back to the saved tags.
function parseDraftTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === 'string') ? value : undefined;
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'Save failed';
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof TRPCClientError)) return false;
  const data = (error as { data?: { code?: unknown } }).data;
  return data?.code === 'NOT_FOUND';
}

function mapServingVariationError(err: unknown): string {
  const code = getDomainErrorCode(err);
  switch (code) {
    case 'RECIPE_BASE_XOR_VIOLATION':
      return 'A recipe cannot be a base and point to another base at the same time.';
    case 'RECIPE_BASE_NOT_FOUND':
      return 'The chosen base recipe could not be found.';
    case 'RECIPE_BASE_NOT_PICKABLE':
      return 'The chosen base recipe is no longer available.';
    default:
      return extractMessage(err);
  }
}

function mapIngredientLineError(
  err: unknown,
  lines: ReplaceRecipeIngredientsLine[],
): ServerLineError | null {
  const code = getDomainErrorCode(err);
  if (!code) return null;
  if (
    code !== 'RECIPE_INGREDIENT_UNIT_MISMATCH' &&
    code !== 'RECIPE_INGREDIENT_NOT_FOUND'
  ) {
    return null;
  }
  if (!(err instanceof TRPCClientError)) return null;
  const cause = (err.shape as { data?: { cause?: { ingredientId?: number } } })
    .data?.cause;
  if (!cause || typeof cause.ingredientId !== 'number') return null;
  const index = lines.findIndex(
    (line) => line.ingredientId === cause.ingredientId,
  );
  if (index < 0) return null;
  return {
    index,
    message:
      code === 'RECIPE_INGREDIENT_UNIT_MISMATCH'
        ? 'Wrong unit for this ingredient'
        : 'Ingredient not available',
  };
}

function NotFound(): React.ReactElement {
  return (
    <section className="mx-auto max-w-3xl space-y-3">
      <h1 className="text-2xl font-semibold">Recipe not found</h1>
      <p className="text-sm">
        <Link to="/recipes" className="hover:underline">
          ← Back to recipes
        </Link>
      </p>
    </section>
  );
}
