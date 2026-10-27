import type { RecipeListItem } from '@loftys-larder/shared';

import { RecipeTypeBadge } from '@/components/planner/recipe-type-badge.tsx';
import {
  SearchableCombobox,
  type SearchableComboboxOption,
} from '@/components/searchable-combobox.tsx';
import type { RecipeChoice } from '@/lib/plan-wizard.ts';
import { trpc } from '@/lib/trpc.ts';

interface RecipeOption extends SearchableComboboxOption {
  recipe: RecipeListItem;
}

// The shared combobox (cross-cutting #6) over pickable recipes, as the slot
// editor searches them, for a Fixed meal or a swap in Plan Review.
export interface RecipePickerProps {
  ariaLabel: string;
  onPick: (recipe: RecipeChoice) => void;
}

export function RecipePicker({
  ariaLabel,
  onPick,
}: RecipePickerProps): React.ReactElement {
  const utils = trpc.useUtils();
  return (
    <SearchableCombobox<RecipeOption>
      value={null}
      ariaLabel={ariaLabel}
      placeholder="Search recipes"
      onChange={(option) => {
        if (!option) return;
        const { recipe } = option;
        onPick({
          id: recipe.id,
          name: recipe.name,
          imageUrl: recipe.imageUrl,
          isBase: recipe.isBase,
          baseRecipeId: recipe.baseRecipeId,
        });
      }}
      searchQuery={async (query) => {
        const result = await utils.recipes.list.fetch({
          search: query || undefined,
          includePickerHidden: true,
          limit: 20,
        });
        return result.items.map((recipe) => ({
          id: recipe.id,
          label: recipe.name,
          recipe,
        }));
      }}
      renderOption={(option) => (
        <span className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate">{option.label}</span>
          <RecipeTypeBadge recipe={option.recipe} />
        </span>
      )}
    />
  );
}
