import type { ListRecipesCursor } from '@loftys-larder/shared';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

import { RecipeCard } from '@/components/recipe-card.tsx';
import { TagFilter } from '@/components/tag-filter.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { trpc } from '@/lib/trpc.ts';

const SEARCH_DEBOUNCE_MS = 200;
const PAGE_SIZE = 30;
// Start fetching the next page while the end of the grid is still this far
// below the viewport, so scrolling rarely hits the loading state.
const LOAD_MORE_ROOT_MARGIN = '600px';

export function RecipesPage(): React.ReactElement {
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [tagIds, setTagIds] = useState<number[]>([]);
  const sentinelRef = useRef<HTMLDivElement>(null);

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
      tagIds: tagIds.length > 0 ? tagIds : undefined,
      limit: PAGE_SIZE,
    },
    {
      getNextPageParam: (lastPage): ListRecipesCursor | undefined =>
        lastPage.nextCursor ?? undefined,
    },
  );

  const {
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    fetchNextPage,
  } = listQuery;

  // Re-subscribing after each fetch makes the observer report the sentinel's
  // current position, so a page that doesn't fill the viewport chains into
  // the next one. A failed page stops the chain until the user retries.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (
      !sentinel ||
      !hasNextPage ||
      isFetchingNextPage ||
      isFetchNextPageError
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void fetchNextPage();
        }
      },
      { rootMargin: LOAD_MORE_ROOT_MARGIN },
    );
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
    };
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

  const recipes = listQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const hasSearch = debouncedSearch.length > 0 || tagIds.length > 0;

  return (
    <section className="mx-auto max-w-6xl space-y-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Recipes</h1>
        <Button asChild>
          <Link to="/recipes/new">New recipe</Link>
        </Button>
      </header>

      <Input
        type="search"
        placeholder="Search by name"
        value={searchInput}
        onChange={(event) => {
          setSearchInput(event.target.value);
        }}
        aria-label="Search recipes"
      />

      <TagFilter selectedIds={tagIds} onChange={setTagIds} />

      {listQuery.isLoading && <p role="status">Loading recipes…</p>}

      {listQuery.error && !isFetchNextPageError && (
        <p role="alert" className="text-sm text-destructive">
          Could not load recipes: {listQuery.error.message}
        </p>
      )}

      {!listQuery.isLoading && !listQuery.error && recipes.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {hasSearch
            ? 'No recipes match your search.'
            : 'No recipes yet. Recipes added via the editor will show up here.'}
        </p>
      )}

      {recipes.length > 0 && (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {recipes.map((recipe) => (
            <li key={recipe.id}>
              <RecipeCard recipe={recipe} />
            </li>
          ))}
        </ul>
      )}

      {hasNextPage && !isFetchNextPageError && (
        <div ref={sentinelRef} aria-hidden="true" />
      )}

      {isFetchingNextPage && (
        <p role="status" className="text-center text-sm text-muted-foreground">
          Loading more recipes…
        </p>
      )}

      {isFetchNextPageError && !isFetchingNextPage && (
        <div className="flex flex-col items-center gap-2">
          <p role="alert" className="text-sm text-destructive">
            Could not load more recipes: {listQuery.error.message}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void fetchNextPage();
            }}
          >
            Try again
          </Button>
        </div>
      )}
    </section>
  );
}
