import type {
  CreateIngredientInput,
  Recipe,
  RecipeReferences,
  ReplaceRecipeIngredientsLine,
  ReplaceRecipeMethodStepInput,
  UpdateRecipeHeaderInput,
} from '@loftys-larder/shared';
import { Link, useParams } from '@tanstack/react-router';
import { TRPCClientError } from '@trpc/client';
import { useCallback, useMemo, useState } from 'react';

import {
  BatchFields,
  type BatchFieldsValues,
  type RecipePickerOption,
} from '@/components/recipe-editor/batch-fields.tsx';
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
} from '@/components/recipe-editor/method-editor.tsx';
import { useRecipeDraft } from '@/hooks/use-recipe-draft.ts';
import { getDomainErrorCode } from '@/lib/domain-error.ts';
import { trpc } from '@/lib/trpc.ts';

type Patch = UpdateRecipeHeaderInput['patch'];

interface EditorDraftShape {
  header: HeaderFormValues;
  ingredients: IngredientDraftLine[];
  method: MethodDraftStep[];
}

export function RecipeEditPage(): React.ReactElement {
  const params = useParams({ from: '/_authed/recipes/$recipeId/edit' });
  const recipeId = Number.parseInt(params.recipeId, 10);
  const idIsValid = Number.isInteger(recipeId) && recipeId > 0;

  const utils = trpc.useUtils();
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
  const updateHeader = trpc.recipes.updateHeader.useMutation();
  const replaceIngredients = trpc.recipes.replaceIngredients.useMutation();
  const replaceMethod = trpc.recipes.replaceMethod.useMutation();
  const setBatchFields = trpc.recipes.setBatchFields.useMutation();

  const [headerSavedKey, setHeaderSavedKey] = useState<number | undefined>();
  const [ingredientsSavedKey, setIngredientsSavedKey] = useState<
    number | undefined
  >();
  const [methodSavedKey, setMethodSavedKey] = useState<number | undefined>();
  const [imageSavedKey, setImageSavedKey] = useState<number | undefined>();
  const [batchSavedKey, setBatchSavedKey] = useState<number | undefined>();
  const [batchError, setBatchError] = useState<string | null>(null);
  const [ingredientErrors, setIngredientErrors] = useState<ServerLineError[]>(
    [],
  );
  const [topLevelError, setTopLevelError] = useState<string | null>(null);

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
        quantity: line.quantity,
        prepTypeId: line.prepTypeId,
      })),
      method: recipe.method.map((step) => ({ instruction: step.instruction })),
    };
  }, [recipe]);

  const draft = useRecipeDraft<EditorDraftShape>({
    recipeId: idIsValid ? recipeId : null,
    enabled: idIsValid && recipe !== null,
    serverDefaults: serverDefaults ?? EMPTY_DRAFT_SHAPE,
  });

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

  const searchPairs = useCallback(
    async (query: string): Promise<readonly RecipePickerOption[]> => {
      const trimmed = query.trim();
      const result = await utils.recipes.list.fetch({
        search: trimmed || undefined,
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

  async function handleHeaderSubmit(values: HeaderFormValues): Promise<void> {
    setTopLevelError(null);
    const patch = diffHeader(serverHeader, values);
    if (Object.keys(patch).length === 0) {
      setHeaderSavedKey(Date.now());
      draft.clearSection('header');
      return;
    }
    try {
      await updateHeader.mutateAsync({ id: recipeId, patch });
      await invalidate();
      setHeaderSavedKey(Date.now());
      draft.clearSection('header');
    } catch (err) {
      setTopLevelError(extractMessage(err));
    }
  }

  async function handleIngredientsSubmit(
    lines: ReplaceRecipeIngredientsLine[],
  ): Promise<void> {
    setTopLevelError(null);
    setIngredientErrors([]);
    try {
      await replaceIngredients.mutateAsync({ recipeId, lines });
      await invalidate();
      setIngredientsSavedKey(Date.now());
      draft.clearSection('ingredients');
    } catch (err) {
      const lineError = mapIngredientLineError(err, lines);
      if (lineError) {
        setIngredientErrors([lineError]);
      } else {
        setTopLevelError(extractMessage(err));
      }
    }
  }

  async function handleMethodSubmit(
    steps: ReplaceRecipeMethodStepInput[],
  ): Promise<void> {
    setTopLevelError(null);
    try {
      await replaceMethod.mutateAsync({ recipeId, steps });
      await invalidate();
      setMethodSavedKey(Date.now());
      draft.clearSection('method');
    } catch (err) {
      setTopLevelError(extractMessage(err));
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

  async function handleBatchSubmit(
    changes: Partial<BatchFieldsValues>,
  ): Promise<void> {
    setBatchError(null);
    try {
      await setBatchFields.mutateAsync({ id: recipeId, ...changes });
      await invalidate();
      setBatchSavedKey(Date.now());
    } catch (err) {
      setBatchError(mapBatchError(err));
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
        mode="edit"
        defaultValues={defaults.header}
        sources={references.sources}
        onSubmit={handleHeaderSubmit}
        onValuesChange={(values) => {
          draft.queueAutosave('header', values);
        }}
        savedNoticeKey={headerSavedKey}
      />

      <BatchFields
        initial={{
          isBase: recipe.isBase,
          baseRecipeId: recipe.baseRecipeId,
          pairedRecipeId: recipe.pairedRecipeId,
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
        pairedRecipePartner={
          recipe.pairedRecipeId !== null && recipe.pairedRecipeName !== null
            ? {
                id: recipe.pairedRecipeId,
                name: recipe.pairedRecipeName,
                isDeleted: recipe.pairedRecipeIsDeleted ?? false,
              }
            : null
        }
        searchBases={searchBases}
        searchPairs={searchPairs}
        onSubmit={handleBatchSubmit}
        savedNoticeKey={batchSavedKey}
        errorMessage={batchError}
      />

      <IngredientList
        initialLines={recipe.ingredients}
        initialDraftLines={defaults.ingredients}
        prepTypes={references.prepTypes}
        searchIngredients={searchIngredients}
        references={ingredientReferencesQuery.data}
        createIngredient={createIngredient}
        onSubmit={handleIngredientsSubmit}
        onLinesChange={(lines) => {
          draft.queueAutosave('ingredients', lines);
        }}
        serverErrors={ingredientErrors}
        savedNoticeKey={ingredientsSavedKey}
      />

      <MethodEditor
        initialSteps={recipe.method}
        initialDraftSteps={defaults.method}
        onSubmit={handleMethodSubmit}
        onStepsChange={(steps) => {
          draft.queueAutosave('method', steps);
        }}
        savedNoticeKey={methodSavedKey}
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
    caloriesPerServing: null,
    proteinPerServing: null,
    carbsPerServing: null,
    fatPerServing: null,
    saturatedFatPerServing: null,
    fibrePerServing: null,
    sugarPerServing: null,
    saltPerServing: null,
    isBase: false,
  },
  ingredients: [],
  method: [],
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
    caloriesPerServing: recipe.caloriesPerServing,
    proteinPerServing: recipe.proteinPerServing,
    carbsPerServing: recipe.carbsPerServing,
    fatPerServing: recipe.fatPerServing,
    saturatedFatPerServing: recipe.saturatedFatPerServing,
    fibrePerServing: recipe.fibrePerServing,
    sugarPerServing: recipe.sugarPerServing,
    saltPerServing: recipe.saltPerServing,
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
  'caloriesPerServing',
  'proteinPerServing',
  'carbsPerServing',
  'fatPerServing',
  'saturatedFatPerServing',
  'fibrePerServing',
  'sugarPerServing',
  'saltPerServing',
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

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'Save failed';
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof TRPCClientError)) return false;
  const data = (error as { data?: { code?: unknown } }).data;
  return data?.code === 'NOT_FOUND';
}

function mapBatchError(err: unknown): string {
  const code = getDomainErrorCode(err);
  switch (code) {
    case 'RECIPE_BATCH_XOR_VIOLATION':
      return 'A recipe cannot be a base and point to another base at the same time.';
    case 'RECIPE_BATCH_BASE_NOT_FOUND':
      return 'The chosen base recipe could not be found.';
    case 'RECIPE_BATCH_BASE_NOT_PICKABLE':
      return 'The chosen base recipe is no longer available.';
    case 'RECIPE_BATCH_PAIR_NOT_FOUND':
      return 'The chosen paired recipe could not be found.';
    case 'RECIPE_BATCH_PAIR_SELF':
      return 'A recipe cannot be paired with itself.';
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
