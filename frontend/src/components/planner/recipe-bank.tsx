import type { ListRecipesCursor, RecipeListItem } from '@loftys-larder/shared';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { trpc } from '@/lib/trpc.ts';
import { cn } from '@/lib/utils.ts';

const SEARCH_DEBOUNCE_MS = 200;
const PAGE_SIZE = 30;

export interface RecipeBankProps {
  selectedRecipeId: number | null;
  onSelect: (recipe: RecipeListItem | null) => void;
}

export function RecipeBank({
  selectedRecipeId,
  onSelect,
}: RecipeBankProps): React.ReactElement {
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(handle);
    };
  }, [searchInput]);

  const listQuery = trpc.recipes.list.useInfiniteQuery(
    {
      search: debouncedSearch || undefined,
      includePickerHidden: true,
      limit: PAGE_SIZE,
    },
    {
      getNextPageParam: (lastPage): ListRecipesCursor | undefined =>
        lastPage.nextCursor ?? undefined,
    },
  );

  const recipes = listQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const hasSearch = debouncedSearch.length > 0;

  return (
    <aside
      aria-label="Recipe bank"
      className="flex h-full flex-col gap-3 rounded-md border border-input bg-card p-3"
    >
      <Input
        type="search"
        placeholder="Search recipes"
        aria-label="Search recipes"
        value={searchInput}
        onChange={(event) => {
          setSearchInput(event.target.value);
        }}
      />

      {listQuery.isLoading && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading recipes…
        </p>
      )}

      {listQuery.error && (
        <p role="alert" className="text-sm text-destructive">
          Could not load recipes: {listQuery.error.message}
        </p>
      )}

      {!listQuery.isLoading && !listQuery.error && recipes.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {hasSearch ? 'No recipes match your search.' : 'No recipes yet.'}
        </p>
      )}

      <ul
        role="listbox"
        aria-label="Pickable recipes"
        aria-activedescendant={
          selectedRecipeId !== null
            ? `recipe-bank-${String(selectedRecipeId)}`
            : undefined
        }
        className="flex flex-1 flex-col gap-2 overflow-y-auto"
      >
        {recipes.map((recipe) => {
          const isSelected = recipe.id === selectedRecipeId;
          return (
            <li key={recipe.id}>
              <button
                type="button"
                id={`recipe-bank-${String(recipe.id)}`}
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  onSelect(isSelected ? null : recipe);
                }}
                className={cn(
                  'flex w-full items-center gap-3 rounded-md border border-input bg-background p-2 text-left transition hover:border-primary focus:outline-none focus:ring-2 focus:ring-ring',
                  isSelected && 'border-primary ring-2 ring-ring',
                )}
              >
                {recipe.imageUrl !== null && (
                  <img
                    src={recipe.imageUrl}
                    alt=""
                    className="h-12 w-12 shrink-0 rounded object-cover"
                  />
                )}
                <span className="flex flex-col">
                  <span className="font-medium">{recipe.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {String(recipe.baseServings)} servings
                    {recipe.isBase && ' · base'}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {listQuery.hasNextPage && (
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void listQuery.fetchNextPage();
          }}
          disabled={listQuery.isFetchingNextPage}
        >
          {listQuery.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </aside>
  );
}
