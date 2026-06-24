import type { RecipeListItem } from '@loftys-larder/shared';
import { Link } from '@tanstack/react-router';

import { formatAverageRating } from '@/lib/format-rating.ts';

export interface RecipeCardProps {
  recipe: RecipeListItem;
}

export function RecipeCard({ recipe }: RecipeCardProps): React.ReactElement {
  const timeLabel =
    recipe.totalTimeMins !== null
      ? `${String(recipe.totalTimeMins)} min`
      : recipe.activeTimeMins !== null
        ? `${String(recipe.activeTimeMins)} min active`
        : null;
  const ratingLabel =
    recipe.ratingCount > 0
      ? `★ ${formatAverageRating(recipe.averageRating) ?? ''} (${String(
          recipe.ratingCount,
        )})`
      : null;

  return (
    <Link
      to="/recipes/$recipeId"
      params={{ recipeId: String(recipe.id) }}
      className="group block overflow-hidden rounded-lg border bg-card text-card-foreground transition hover:border-primary"
      data-testid={`recipe-card-${String(recipe.id)}`}
    >
      <div className="aspect-[4/3] w-full overflow-hidden bg-muted">
        {recipe.imageUrl ? (
          <img
            src={recipe.imageUrl}
            alt={recipe.name}
            className="h-full w-full object-cover transition group-hover:scale-[1.02]"
          />
        ) : (
          <div
            aria-hidden="true"
            className="flex h-full w-full items-center justify-center text-xs text-foreground/70"
          >
            No image
          </div>
        )}
      </div>
      <div className="space-y-1 p-3">
        <div className="flex items-start justify-between gap-2">
          <p className="font-medium leading-tight">{recipe.name}</p>
          {recipe.isBase && (
            <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
              Base recipe
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {timeLabel && <span>{timeLabel}</span>}
          {timeLabel && <span aria-hidden="true">·</span>}
          <span aria-label="plant points">
            🌱 {String(recipe.plantPointsCount)}
          </span>
          {ratingLabel && (
            <>
              <span aria-hidden="true">·</span>
              <span aria-label="average rating">{ratingLabel}</span>
            </>
          )}
        </div>
      </div>
    </Link>
  );
}
