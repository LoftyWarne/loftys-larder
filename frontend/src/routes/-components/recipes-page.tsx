import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import { RecipeCard } from '@/components/recipe-card.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { trpc } from '@/lib/trpc.ts';

const SEARCH_DEBOUNCE_MS = 200;

export function RecipesPage(): React.ReactElement {
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

  const listQuery = trpc.recipes.list.useQuery(
    debouncedSearch ? { search: debouncedSearch } : undefined,
  );

  const recipes = listQuery.data?.items ?? [];
  const hasSearch = debouncedSearch.length > 0;

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

      {listQuery.isLoading && <p role="status">Loading recipes…</p>}

      {listQuery.error && (
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
    </section>
  );
}
