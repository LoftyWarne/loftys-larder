import type { PlanSlotItem } from '@loftys-larder/shared';
import { Link } from '@tanstack/react-router';

import { dishServingsSearch } from '@/lib/slot-display.ts';

// A dish name, linking through to its recipe detail page. A recipe soft-deleted
// after assignment renders tagged "(deleted)" (DEC-21) and never links — there's
// no live recipe to open. Names stay plain text (DEC-49). A dish being cooked
// opens scaled to the portions prepared (DEC-98); one only eaten here
// (leftovers, `prepared = 0`) opens at the recipe's own servings.
export function RecipeNameLink({
  item,
}: {
  item: Pick<
    PlanSlotItem,
    'recipeId' | 'recipeName' | 'isDeleted' | 'prepared'
  >;
}): React.ReactElement {
  if (item.isDeleted) {
    return (
      <>
        {item.recipeName}
        <span className="ml-1 text-xs text-muted-foreground">(deleted)</span>
      </>
    );
  }
  return (
    <Link
      to="/recipes/$recipeId"
      params={{ recipeId: String(item.recipeId) }}
      search={dishServingsSearch(item)}
      className="font-medium text-primary underline-offset-2 hover:underline focus-visible:underline"
    >
      {item.recipeName}
    </Link>
  );
}
