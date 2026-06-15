import type { RelatedRecipeItem } from '@loftys-larder/shared';
import { Link } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import {
  SearchableCombobox,
  type SearchableComboboxOption,
} from '@/components/searchable-combobox.tsx';
import { trpc } from '@/lib/trpc.ts';

export interface RelatedRecipesProps {
  recipeId: number;
  isDisabled?: boolean;
}

type RelatedPickerOption = SearchableComboboxOption;

const PICKER_LIMIT = 10;

export function RelatedRecipes({
  recipeId,
  isDisabled = false,
}: RelatedRecipesProps): React.ReactElement {
  const utils = trpc.useUtils();
  const listQuery = trpc.recipes.listRelated.useQuery({ recipeId });
  const items: readonly RelatedRecipeItem[] = useMemo(
    () => listQuery.data?.items ?? [],
    [listQuery.data],
  );

  // Bumping `resetCount` remounts the combobox with empty state — the
  // primitive holds its own input string locally, so toggling the `value`
  // prop from null→null in the same batch doesn't trigger its clear effect.
  // A key change is the simplest way to reset both input + selection.
  const [resetCount, setResetCount] = useState(0);

  const invalidateList = useCallback(async (): Promise<void> => {
    await utils.recipes.listRelated.invalidate({ recipeId });
  }, [utils.recipes.listRelated, recipeId]);

  const addMutation = trpc.recipes.addRelated.useMutation({
    onSettled: invalidateList,
  });
  const removeMutation = trpc.recipes.removeRelated.useMutation({
    onSettled: invalidateList,
  });

  const mutationPending = addMutation.isPending || removeMutation.isPending;
  const disabled = isDisabled || mutationPending;

  // Stable lookup of every already-linked id so the combobox suggestions can
  // strip them out without re-walking the list per option.
  const linkedIds = useMemo(
    () => new Set<number>(items.map((row) => row.id)),
    [items],
  );

  const searchRelated = useCallback(
    async (query: string): Promise<readonly RelatedPickerOption[]> => {
      const trimmed = query.trim();
      const result = await utils.recipes.list.fetch({
        search: trimmed || undefined,
        includePickerHidden: true,
        limit: PICKER_LIMIT,
      });
      return result.items
        .filter((row) => row.id !== recipeId && !linkedIds.has(row.id))
        .map((row) => ({ id: row.id, label: row.name }));
    },
    [utils.recipes.list, recipeId, linkedIds],
  );

  const handlePick = (option: RelatedPickerOption | null): void => {
    if (option === null) return;
    addMutation.mutate(
      { recipeId, otherRecipeId: option.id },
      {
        onSuccess: () => {
          setResetCount((count) => count + 1);
        },
      },
    );
  };

  const errorMessage = formatMutationError(
    addMutation.error ?? removeMutation.error,
  );

  return (
    <section className="space-y-3" aria-labelledby="related-recipes-heading">
      <h2 id="related-recipes-heading" className="text-xl font-semibold">
        Related recipes
      </h2>

      <div className="space-y-1">
        <label htmlFor="related-recipes-search" className="sr-only">
          Search recipes to link
        </label>
        <SearchableCombobox
          key={resetCount}
          id="related-recipes-search"
          ariaLabel="Search recipes to link"
          value={null}
          onChange={handlePick}
          searchQuery={searchRelated}
          placeholder="Link a recipe…"
          emptyMessage="No matches"
          disabled={disabled}
        />
      </div>

      {errorMessage && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage}
        </p>
      )}

      {listQuery.isLoading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading related recipes…
        </p>
      ) : listQuery.error ? (
        <p role="alert" className="text-sm text-destructive">
          Could not load related recipes: {listQuery.error.message}
        </p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No related recipes yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {items.map((item) => (
            <li key={item.id}>
              <Chip
                item={item}
                disabled={disabled}
                onRemove={() => {
                  removeMutation.mutate({
                    recipeId,
                    otherRecipeId: item.id,
                  });
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface ChipProps {
  item: RelatedRecipeItem;
  disabled: boolean;
  onRemove: () => void;
}

function Chip({ item, disabled, onRemove }: ChipProps): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-input bg-muted px-2 py-0.5 text-sm">
      <Link
        to="/recipes/$recipeId"
        params={{ recipeId: String(item.id) }}
        className="hover:underline"
      >
        {item.name}
      </Link>
      <button
        type="button"
        aria-label={`Remove ${item.name}`}
        disabled={disabled}
        onClick={onRemove}
        className="text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        ×
      </button>
    </span>
  );
}

function formatMutationError(error: unknown): string | null {
  if (!error) return null;
  const message =
    typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : 'Could not update related recipes';
  const code = (error as { data?: { cause?: { code?: unknown } } }).data?.cause
    ?.code;
  if (code === 'RELATED_RECIPE_DUPLICATE') {
    return 'These recipes are already linked';
  }
  if (code === 'RELATED_RECIPE_SELF_LINK') {
    return 'A recipe cannot be related to itself';
  }
  if (code === 'RELATED_RECIPE_NOT_PICKABLE') {
    return 'Recipe is not available to link';
  }
  return message;
}
