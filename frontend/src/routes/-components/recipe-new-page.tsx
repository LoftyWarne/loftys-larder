import type { RecipeReferenceItem } from '@loftys-larder/shared';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import {
  HeaderFields,
  type HeaderFormValues,
} from '@/components/recipe-editor/header-fields.tsx';
import { useRecipeDraft } from '@/hooks/use-recipe-draft.ts';
import { trpc } from '@/lib/trpc.ts';

interface NewRecipeDraftShape {
  header: HeaderFormValues;
}

function blankDefaults(): HeaderFormValues {
  return {
    name: '',
    description: null,
    imageUrl: null,
    baseServings: 2,
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
    isBase: false,
  };
}

export function RecipeNewPage(): React.ReactElement {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const referencesQuery = trpc.recipes.references.useQuery();
  const createMutation = trpc.recipes.create.useMutation();
  const createSourceMutation = trpc.recipes.createSource.useMutation();
  const [submitError, setSubmitError] = useState<string | null>(null);

  const createSource = useCallback(
    async (name: string): Promise<RecipeReferenceItem> => {
      const created = await createSourceMutation.mutateAsync({ name });
      await utils.recipes.references.invalidate();
      return created;
    },
    [createSourceMutation, utils.recipes.references],
  );

  const defaults = useMemo(blankDefaults, []);
  const serverDefaults = useMemo<NewRecipeDraftShape>(
    () => ({ header: defaults }),
    [defaults],
  );
  const sources = referencesQuery.data?.sources ?? [];

  const draft = useRecipeDraft<NewRecipeDraftShape>({
    recipeId: null,
    enabled: true,
    serverDefaults,
  });

  async function handleSubmit(values: HeaderFormValues): Promise<boolean> {
    setSubmitError(null);
    try {
      const result = await createMutation.mutateAsync(values);
      // A new recipe identity replaces the new-recipe draft — clear the row
      // before navigating so a return to /recipes/new starts blank.
      draft.discardDraft();
      await navigate({
        to: '/recipes/$recipeId/edit',
        params: { recipeId: String(result.id) },
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not save';
      setSubmitError(message);
      return false;
    }
  }

  if (!draft.isReady) {
    return (
      <p role="status" className="text-sm">
        Loading…
      </p>
    );
  }

  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-1">
        <p className="text-sm font-medium text-muted-foreground">Step 1 of 2</p>
        <h1 className="text-2xl font-semibold">New recipe</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Start with the basics and save. Next you&rsquo;ll add ingredients,
        method, and a photo.
      </p>

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

      <HeaderFields
        mode="create"
        defaultValues={draft.mergedDefaults.header}
        sources={sources}
        createSource={createSource}
        onSubmit={handleSubmit}
        onValuesChange={(values) => {
          draft.queueAutosave('header', values);
        }}
        submitLabel="Save & continue →"
      />

      {submitError && (
        <p role="alert" className="text-sm text-destructive">
          {submitError}
        </p>
      )}
    </section>
  );
}
