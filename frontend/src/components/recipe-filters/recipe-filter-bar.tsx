import { Button } from '@/components/ui/button.tsx';
import {
  hasRecipeFilters,
  idsOrUndefined,
  NO_RECIPE_FILTERS,
  type RecipeFilters,
} from '@/lib/recipe-filters.ts';
import { trpc } from '@/lib/trpc.ts';

import { ChecklistFilter } from './checklist-filter.tsx';
import { IngredientFilter } from './ingredient-filter.tsx';
import { TimeFilter } from './time-filter.tsx';

// The recipes page's filters (DEC-100). Every filter ANDs with the others and
// with the name search. `onChange` gets only the keys that changed.
export interface RecipeFilterBarProps {
  filters: RecipeFilters;
  onChange: (patch: RecipeFilters) => void;
}

export function RecipeFilterBar({
  filters,
  onChange,
}: RecipeFilterBarProps): React.ReactElement {
  const tagsQuery = trpc.recipes.listTags.useQuery();
  const sourcesQuery = trpc.recipes.listSources.useQuery();
  const ingredientsQuery = trpc.recipes.listIngredients.useQuery();

  return (
    <div
      role="group"
      aria-label="Filter recipes"
      className="flex flex-wrap items-center gap-2"
    >
      <ChecklistFilter
        label="Tags"
        options={tagsQuery.data ?? []}
        selectedIds={filters.tags ?? []}
        onChange={(ids) => {
          onChange({ tags: idsOrUndefined(ids) });
        }}
      />
      <ChecklistFilter
        label="Source"
        options={sourcesQuery.data ?? []}
        selectedIds={filters.sources ?? []}
        onChange={(ids) => {
          onChange({ sources: idsOrUndefined(ids) });
        }}
      />
      <TimeFilter
        label="Total time"
        value={filters.maxTotal}
        onChange={(limit) => {
          onChange({ maxTotal: limit });
        }}
      />
      <TimeFilter
        label="Active time"
        value={filters.maxActive}
        onChange={(limit) => {
          onChange({ maxActive: limit });
        }}
      />
      <IngredientFilter
        options={ingredientsQuery.data ?? []}
        selectedIds={filters.ingredients ?? []}
        onChange={(ids) => {
          onChange({ ingredients: idsOrUndefined(ids) });
        }}
      />
      {hasRecipeFilters(filters) && (
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={() => {
            onChange(NO_RECIPE_FILTERS);
          }}
        >
          Clear filters
        </Button>
      )}
    </div>
  );
}
