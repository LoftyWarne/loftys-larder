import type { Rating, Recipe } from '@loftys-larder/shared';

import { cn } from '@/lib/utils.ts';
import { trpc } from '@/lib/trpc.ts';

const STAR_VALUES: readonly Rating[] = [1, 2, 3, 4, 5];

export interface RecipeRatingProps {
  recipeId: number;
  yourRating: Recipe['yourRating'];
  isDisabled?: boolean;
}

export function RecipeRating({
  recipeId,
  yourRating,
  isDisabled = false,
}: RecipeRatingProps): React.ReactElement {
  const utils = trpc.useUtils();

  const rateMutation = trpc.recipes.rate.useMutation({
    onMutate: async ({ rating }) => {
      await utils.recipes.get.cancel({ id: recipeId });
      const previous = utils.recipes.get.getData({ id: recipeId });
      if (previous) {
        utils.recipes.get.setData(
          { id: recipeId },
          applyRating(previous, rating),
        );
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) {
        utils.recipes.get.setData({ id: recipeId }, ctx.previous);
      }
    },
    onSettled: async () => {
      await utils.recipes.get.invalidate({ id: recipeId });
      await utils.recipes.list.invalidate();
    },
  });

  const unrateMutation = trpc.recipes.unrate.useMutation({
    onMutate: async () => {
      await utils.recipes.get.cancel({ id: recipeId });
      const previous = utils.recipes.get.getData({ id: recipeId });
      if (previous) {
        utils.recipes.get.setData(
          { id: recipeId },
          applyRating(previous, null),
        );
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) {
        utils.recipes.get.setData({ id: recipeId }, ctx.previous);
      }
    },
    onSettled: async () => {
      await utils.recipes.get.invalidate({ id: recipeId });
      await utils.recipes.list.invalidate();
    },
  });

  const isPending = rateMutation.isPending || unrateMutation.isPending;
  const disabled = isDisabled || isPending;

  const handleClick = (value: Rating): void => {
    if (disabled) return;
    if (value === yourRating) {
      unrateMutation.mutate({ recipeId });
    } else {
      rateMutation.mutate({ recipeId, rating: value });
    }
  };

  return (
    <div
      className="flex items-center gap-1"
      role="group"
      aria-label="Your rating"
    >
      {STAR_VALUES.map((value) => {
        const isFilled = yourRating !== null && value <= yourRating;
        const isSelected = value === yourRating;
        return (
          <button
            key={value}
            type="button"
            onClick={() => {
              handleClick(value);
            }}
            disabled={disabled}
            aria-label={
              isSelected ? `Clear your rating` : `Rate ${String(value)} stars`
            }
            aria-pressed={isSelected}
            className={cn(
              'text-xl leading-none transition disabled:cursor-not-allowed disabled:opacity-50',
              isFilled ? 'text-yellow-500' : 'text-muted-foreground',
            )}
          >
            {isFilled ? '★' : '☆'}
          </button>
        );
      })}
    </div>
  );
}

function applyRating(recipe: Recipe, nextRating: Rating | null): Recipe {
  const previousRating = recipe.yourRating;
  if (previousRating === nextRating) return recipe;

  let { averageRating, ratingCount } = recipe;
  const totalBefore = averageRating === null ? 0 : averageRating * ratingCount;

  let totalAfter = totalBefore;
  let countAfter = ratingCount;

  if (previousRating === null && nextRating !== null) {
    totalAfter = totalBefore + nextRating;
    countAfter = ratingCount + 1;
  } else if (previousRating !== null && nextRating === null) {
    totalAfter = totalBefore - previousRating;
    countAfter = ratingCount - 1;
  } else if (previousRating !== null && nextRating !== null) {
    totalAfter = totalBefore - previousRating + nextRating;
  }

  averageRating = countAfter === 0 ? null : totalAfter / countAfter;
  ratingCount = countAfter;

  return { ...recipe, yourRating: nextRating, averageRating, ratingCount };
}
