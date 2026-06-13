import type {
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
  HeaderFields,
  type HeaderFormValues,
} from '@/components/recipe-editor/header-fields.tsx';
import { ImageUploader } from '@/components/recipe-editor/image-uploader.tsx';
import {
  IngredientList,
  type IngredientPickerOption,
  type ServerLineError,
} from '@/components/recipe-editor/ingredient-list.tsx';
import { MethodEditor } from '@/components/recipe-editor/method-editor.tsx';
import { getDomainErrorCode } from '@/lib/domain-error.ts';
import { trpc } from '@/lib/trpc.ts';

type Patch = UpdateRecipeHeaderInput['patch'];

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
  const credentialsQuery = trpc.uploads.getRecipeImageCredentials.useQuery(
    undefined,
    { enabled: false },
  );

  const updateHeader = trpc.recipes.updateHeader.useMutation();
  const replaceIngredients = trpc.recipes.replaceIngredients.useMutation();
  const replaceMethod = trpc.recipes.replaceMethod.useMutation();

  const [headerSavedKey, setHeaderSavedKey] = useState<number | undefined>();
  const [ingredientsSavedKey, setIngredientsSavedKey] = useState<
    number | undefined
  >();
  const [methodSavedKey, setMethodSavedKey] = useState<number | undefined>();
  const [imageSavedKey, setImageSavedKey] = useState<number | undefined>();
  const [ingredientErrors, setIngredientErrors] = useState<ServerLineError[]>(
    [],
  );
  const [topLevelError, setTopLevelError] = useState<string | null>(null);

  const recipe = recipeQuery.data ?? null;
  const headerDefaults = useMemo<HeaderFormValues | null>(
    () => (recipe ? toHeaderDefaults(recipe) : null),
    [recipe],
  );

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
  if (!recipe || !headerDefaults) return <NotFound />;

  const references: RecipeReferences = referencesQuery.data ?? {
    units: [],
    prepTypes: [],
    sources: [],
  };
  const defaults = headerDefaults;

  async function invalidate(): Promise<void> {
    await utils.recipes.get.invalidate({ id: recipeId });
  }

  async function handleHeaderSubmit(values: HeaderFormValues): Promise<void> {
    setTopLevelError(null);
    const patch = diffHeader(defaults, values);
    if (Object.keys(patch).length === 0) {
      setHeaderSavedKey(Date.now());
      return;
    }
    try {
      await updateHeader.mutateAsync({ id: recipeId, patch });
      await invalidate();
      setHeaderSavedKey(Date.now());
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
    } catch (err) {
      // Try to map domain errors to per-line messages.
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

      {topLevelError && (
        <p role="alert" className="text-sm text-destructive">
          {topLevelError}
        </p>
      )}

      <HeaderFields
        mode="edit"
        defaultValues={defaults}
        sources={references.sources}
        onSubmit={handleHeaderSubmit}
        savedNoticeKey={headerSavedKey}
      />

      <IngredientList
        initialLines={recipe.ingredients}
        prepTypes={references.prepTypes}
        searchIngredients={searchIngredients}
        onSubmit={handleIngredientsSubmit}
        serverErrors={ingredientErrors}
        savedNoticeKey={ingredientsSavedKey}
      />

      <MethodEditor
        initialSteps={recipe.method}
        onSubmit={handleMethodSubmit}
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
      // The cast is sound — both source values are typed to the same field
      // shape on HeaderFormValues, which mirrors the Patch shape for these
      // keys.
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
