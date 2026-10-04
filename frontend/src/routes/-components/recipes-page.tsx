import type {
  ListRecipesCursor,
  RecipeListSearch,
} from '@loftys-larder/shared';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { RecipeCard } from '@/components/recipe-card.tsx';
import { RecipeFilterBar } from '@/components/recipe-filters/recipe-filter-bar.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover.tsx';
import { useOnlineStatus } from '@/hooks/use-online-status.ts';
import { hasRecipeFilters, listInputFromSearch } from '@/lib/recipe-filters.ts';
import { trpc } from '@/lib/trpc.ts';

const SEARCH_DEBOUNCE_MS = 200;
const PAGE_SIZE = 30;
// Start fetching the next page while the end of the grid is still this far
// below the viewport, so scrolling rarely hits the loading state.
const LOAD_MORE_ROOT_MARGIN = '600px';

export function RecipesPage(): React.ReactElement {
  // The name search and filters live in the URL so they survive opening a
  // recipe and pressing Back (DEC-100).
  const search = useSearch({ from: '/_authed/recipes/' });
  const navigate = useNavigate({ from: '/recipes/' });
  const [searchInput, setSearchInput] = useState(search.q ?? '');
  // The last name search this page wrote to the URL, so that write landing
  // isn't mistaken for a link that changed the search.
  const writtenQuery = useRef(search.q);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const updateSearch = useCallback(
    (patch: Partial<RecipeListSearch>) => {
      void navigate({
        search: (prev) => ({ ...prev, ...patch }),
        replace: true,
        resetScroll: false,
      });
    },
    [navigate],
  );

  useEffect(() => {
    const next = searchInput.trim() || undefined;
    if (next === search.q) return;
    const handle = window.setTimeout(() => {
      writtenQuery.current = next;
      updateSearch({ q: next });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(handle);
    };
  }, [searchInput, search.q, updateSearch]);

  // A link to this page (e.g. the nav) can change the search while the page
  // stays mounted; the box then shows what the URL says.
  useEffect(() => {
    if (search.q === writtenQuery.current) return;
    writtenQuery.current = search.q;
    setSearchInput(search.q ?? '');
  }, [search.q]);

  const listQuery = trpc.recipes.list.useInfiniteQuery(
    listInputFromSearch(search, PAGE_SIZE),
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
  const isNarrowed = search.q !== undefined || hasRecipeFilters(search);

  return (
    <section className="mx-auto max-w-6xl space-y-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Recipes</h1>
        <NewRecipeMenu />
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

      <RecipeFilterBar filters={search} onChange={updateSearch} />

      {listQuery.isLoading && <p role="status">Loading recipes…</p>}

      {listQuery.error && !isFetchNextPageError && (
        <p role="alert" className="text-sm text-destructive">
          Could not load recipes: {listQuery.error.message}
        </p>
      )}

      {!listQuery.isLoading && !listQuery.error && recipes.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {isNarrowed
            ? 'No recipes match your search and filters.'
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

const MENU_ITEM_CLASS =
  'rounded-sm px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none';

// Start blank (the manual flow, unchanged) or Import (DEC-108). Import needs
// a connection (DEC-103).
function NewRecipeMenu(): React.ReactElement {
  const isOnline = useOnlineStatus();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button">New recipe</Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 p-1">
        <nav aria-label="New recipe" className="flex flex-col">
          <Link to="/recipes/new" className={MENU_ITEM_CLASS}>
            Start blank
          </Link>
          {isOnline ? (
            <Link to="/recipes/import" className={MENU_ITEM_CLASS}>
              Import
            </Link>
          ) : (
            <span
              aria-disabled="true"
              className="px-3 py-2 text-sm text-muted-foreground"
            >
              Import (needs a connection)
            </span>
          )}
        </nav>
      </PopoverContent>
    </Popover>
  );
}
