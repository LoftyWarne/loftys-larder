import { TRPCClientError } from '@trpc/client';
import { Link, useParams } from '@tanstack/react-router';

import { trpc } from '@/lib/trpc.ts';

export function RecipeDetailPage(): React.ReactElement {
  const params = useParams({ from: '/_authed/recipes/$recipeId' });
  const recipeId = Number.parseInt(params.recipeId, 10);
  const idIsValid = Number.isInteger(recipeId) && recipeId > 0;

  const query = trpc.recipes.get.useQuery(
    { id: recipeId },
    { enabled: idIsValid, retry: false },
  );

  if (!idIsValid) {
    return <NotFound />;
  }

  if (query.isLoading) {
    return <p role="status">Loading recipe…</p>;
  }

  if (query.error) {
    if (isNotFoundError(query.error)) return <NotFound />;
    return (
      <p role="alert" className="text-sm text-destructive">
        Could not load recipe: {query.error.message}
      </p>
    );
  }

  const recipe = query.data;
  if (!recipe) return <NotFound />;

  return (
    <article className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-2">
        <p className="text-sm">
          <Link to="/recipes" className="text-muted-foreground hover:underline">
            ← Back to recipes
          </Link>
        </p>
        <h1 className="text-3xl font-semibold">{recipe.name}</h1>
        {recipe.description && (
          <p className="text-muted-foreground">{recipe.description}</p>
        )}
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span>Serves {String(recipe.baseServings)}</span>
          {recipe.totalTimeMins !== null && (
            <span>· {String(recipe.totalTimeMins)} min total</span>
          )}
          {recipe.activeTimeMins !== null && (
            <span>· {String(recipe.activeTimeMins)} min active</span>
          )}
          <span>· 🌱 {String(recipe.plantPointsCount)}</span>
          {recipe.sourceName && (
            <span>
              ·{' '}
              {recipe.sourceUrl ? (
                <a
                  href={recipe.sourceUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="hover:underline"
                >
                  {recipe.sourceName}
                </a>
              ) : (
                recipe.sourceName
              )}
            </span>
          )}
        </p>
      </header>

      {recipe.imageUrl && (
        <img
          src={recipe.imageUrl}
          alt={recipe.name}
          className="aspect-[4/3] w-full rounded-lg object-cover"
        />
      )}

      <section className="space-y-2" aria-labelledby="ingredients-heading">
        <h2 id="ingredients-heading" className="text-xl font-semibold">
          Ingredients
        </h2>
        {recipe.ingredients.length === 0 ? (
          <p className="text-sm text-muted-foreground">No ingredients yet.</p>
        ) : (
          <ul className="space-y-1">
            {recipe.ingredients.map((line) => (
              <li key={line.id} className="text-sm">
                <span className="font-medium">
                  {line.quantity} {line.unitName}
                </span>{' '}
                {line.ingredientName}
                {line.prepTypeName && (
                  <span className="text-muted-foreground">
                    , {line.prepTypeName}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2" aria-labelledby="method-heading">
        <h2 id="method-heading" className="text-xl font-semibold">
          Method
        </h2>
        {recipe.method.length === 0 ? (
          <p className="text-sm text-muted-foreground">No method yet.</p>
        ) : (
          <ol className="space-y-2 list-decimal pl-5">
            {recipe.method.map((step) => (
              <li key={step.id} className="text-sm">
                {step.instruction}
              </li>
            ))}
          </ol>
        )}
      </section>
    </article>
  );
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof TRPCClientError)) return false;
  const data = (error as { data?: { code?: unknown } }).data;
  return data?.code === 'NOT_FOUND';
}

function NotFound(): React.ReactElement {
  return (
    <section className="mx-auto max-w-3xl space-y-3">
      <h1 className="text-2xl font-semibold">Recipe not found</h1>
      <p className="text-sm text-muted-foreground">
        This recipe doesn’t exist or isn’t available.
      </p>
      <p className="text-sm">
        <Link to="/recipes" className="hover:underline">
          ← Back to recipes
        </Link>
      </p>
    </section>
  );
}
