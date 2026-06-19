import type {
  ShoppingListCategory,
  ShoppingListLine,
} from '@loftys-larder/shared';

import { ListLine } from './list-line.tsx';

export interface CategorySectionProps {
  category: ShoppingListCategory;
  onToggle: (line: ShoppingListLine, nextChecked: boolean) => void;
}

// Section per ingredient category. Headers render in the order the server
// returns — display order is decided by the aggregation procedure.
export function CategorySection({
  category,
  onToggle,
}: CategorySectionProps): React.ReactElement {
  return (
    <section
      data-shopping-category
      data-category-id={category.category.id}
      className="space-y-1"
    >
      <h2 className="text-lg font-semibold tracking-tight">
        {category.category.name}
      </h2>
      <ul className="rounded-md border bg-card px-3">
        {category.lines.map((line) => (
          <ListLine key={line.ingredient.id} line={line} onToggle={onToggle} />
        ))}
      </ul>
    </section>
  );
}
