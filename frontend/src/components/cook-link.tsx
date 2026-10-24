import type { PlanSlotItem } from '@loftys-larder/shared';
import { Link } from '@tanstack/react-router';
import { ChefHat } from 'lucide-react';

import { dishServingsSearch } from '@/lib/slot-display.ts';

// Opens a dish being cooked in cook mode at the portions prepared (DEC-116).
// A dish only eaten here (`prepared = 0`) has nothing to cook, and a deleted
// recipe has no live recipe to open, so neither gets the link.
export function CookLink({
  item,
}: {
  item: Pick<
    PlanSlotItem,
    'recipeId' | 'recipeName' | 'isDeleted' | 'prepared'
  >;
}): React.ReactElement | null {
  if (item.isDeleted || item.prepared <= 0) return null;
  return (
    <Link
      to="/recipes/$recipeId/cook"
      params={{ recipeId: String(item.recipeId) }}
      search={dishServingsSearch(item)}
      aria-label={`Cook ${item.recipeName}`}
      title="Cook"
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ChefHat aria-hidden className="size-4" />
    </Link>
  );
}
