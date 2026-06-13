import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import {
  HeaderFields,
  type HeaderFormValues,
} from '@/components/recipe-editor/header-fields.tsx';
import { trpc } from '@/lib/trpc.ts';

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
  const referencesQuery = trpc.recipes.references.useQuery();
  const createMutation = trpc.recipes.create.useMutation();
  const [submitError, setSubmitError] = useState<string | null>(null);

  const defaults = useMemo(blankDefaults, []);
  const sources = referencesQuery.data?.sources ?? [];

  async function handleSubmit(values: HeaderFormValues): Promise<void> {
    setSubmitError(null);
    try {
      const result = await createMutation.mutateAsync(values);
      await navigate({
        to: '/recipes/$recipeId/edit',
        params: { recipeId: String(result.id) },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not save';
      setSubmitError(message);
    }
  }

  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">New recipe</h1>
      <p className="text-sm text-muted-foreground">
        Fill in the details and save. You&rsquo;ll then be able to add
        ingredients, method, and a photo.
      </p>

      <HeaderFields
        mode="create"
        defaultValues={defaults}
        sources={sources}
        onSubmit={handleSubmit}
        submitLabel="Create recipe"
      />

      {submitError && (
        <p role="alert" className="text-sm text-destructive">
          {submitError}
        </p>
      )}
    </section>
  );
}
