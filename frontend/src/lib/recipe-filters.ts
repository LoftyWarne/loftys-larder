import type { ListRecipesInput, RecipeListSearch } from '@loftys-larder/shared';

// The recipes page's filters live in its URL (DEC-100); these helpers map that
// search object to the `recipes.list` input and back.
export type RecipeFilters = Omit<RecipeListSearch, 'q'>;

export const RECIPE_TIME_LIMITS = [15, 30, 45, 60, 90, 120] as const;

export const NO_RECIPE_FILTERS = {
  tags: undefined,
  sources: undefined,
  ingredients: undefined,
  maxTotal: undefined,
  maxActive: undefined,
} satisfies Record<keyof RecipeFilters, undefined>;

export interface RecipeFilterOption {
  id: number;
  name: string;
}

// Takes the whole URL search too, so `q` must not count as a filter.
export function hasRecipeFilters(filters: RecipeFilters): boolean {
  return (
    filters.tags !== undefined ||
    filters.sources !== undefined ||
    filters.ingredients !== undefined ||
    filters.maxTotal !== undefined ||
    filters.maxActive !== undefined
  );
}

// What a multi-select filter's button shows once set: the one name, or a
// count (also used while the names are still loading).
export function selectionSummary(
  selectedIds: readonly number[],
  options: readonly RecipeFilterOption[],
): string | null {
  if (selectedIds.length === 0) return null;
  if (selectedIds.length === 1) {
    const only = options.find((option) => option.id === selectedIds[0]);
    if (only) return only.name;
  }
  return `${String(selectedIds.length)} selected`;
}

export function listInputFromSearch(
  search: RecipeListSearch,
  limit: number,
): NonNullable<ListRecipesInput> {
  return {
    search: search.q,
    tagIds: search.tags,
    sourceIds: search.sources,
    ingredientIds: search.ingredients,
    maxTotalTimeMins: search.maxTotal,
    maxActiveTimeMins: search.maxActive,
    limit,
  };
}

// An empty selection is written as absent, so the URL drops the key.
export function idsOrUndefined(ids: readonly number[]): number[] | undefined {
  return ids.length > 0 ? [...ids] : undefined;
}
