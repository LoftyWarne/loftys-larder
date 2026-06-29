import { cn } from '@/lib/utils.ts';

export type RecipeType = 'Base' | 'Variant' | 'Standalone';

// The three-way recipe model (DEC-23, XOR-enforced): a recipe is a base, a
// serving variation of a base, or a standalone dish. One classifier serves the
// picker options, the editor rows, and the slot card.
export function recipeType(recipe: {
  isBase: boolean;
  baseRecipeId: number | null;
}): RecipeType {
  if (recipe.isBase) return 'Base';
  if (recipe.baseRecipeId !== null) return 'Variant';
  return 'Standalone';
}

const TYPE_CLASS: Record<RecipeType, string> = {
  Base: 'bg-amber-50 text-amber-800',
  Variant: 'bg-sky-50 text-sky-800',
  Standalone: 'bg-muted text-muted-foreground',
};

export interface RecipeTypeBadgeProps {
  recipe: { isBase: boolean; baseRecipeId: number | null };
  className?: string;
}

export function RecipeTypeBadge({
  recipe,
  className,
}: RecipeTypeBadgeProps): React.ReactElement {
  const type = recipeType(recipe);
  return (
    <span
      data-testid="recipe-type-badge"
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium',
        TYPE_CLASS[type],
        className,
      )}
    >
      {type}
    </span>
  );
}
