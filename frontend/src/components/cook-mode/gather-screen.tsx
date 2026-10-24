import type { RecipeIngredientLine } from '@loftys-larder/shared';

import { Checkbox } from '@/components/ui/checkbox.tsx';
import { formatScaledQuantity } from '@/lib/scale-quantity.ts';
import { cn } from '@/lib/utils.ts';

interface GatherScreenProps {
  lines: readonly RecipeIngredientLine[];
  factor: number;
  ticked: ReadonlySet<number>;
  onToggle: (lineId: number) => void;
}

// Cook mode's first screen (DEC-116): the scaled ingredient list with a tick
// box per line. Ticks are for the cook's reference and never block moving on.
export function GatherScreen({
  lines,
  factor,
  ticked,
  onToggle,
}: GatherScreenProps): React.ReactElement {
  if (lines.length === 0) {
    return (
      <p className="text-lg text-muted-foreground">
        This recipe has no ingredients.
      </p>
    );
  }
  return (
    <ul className="space-y-1" aria-label="Ingredients">
      {lines.map((line) => {
        const id = `cook-ingredient-${String(line.id)}`;
        const isTicked = ticked.has(line.id);
        return (
          <li key={line.id} className="flex items-center gap-3">
            <Checkbox
              id={id}
              checked={isTicked}
              onCheckedChange={() => {
                onToggle(line.id);
              }}
              className="size-6"
            />
            <label
              htmlFor={id}
              className={cn(
                'flex-1 cursor-pointer py-2 text-xl',
                isTicked && 'text-muted-foreground line-through',
              )}
            >
              <span className="font-semibold">
                {formatScaledQuantity(
                  Number(line.quantity),
                  line.unitName,
                  factor,
                )}{' '}
                {line.unitName}
              </span>{' '}
              {line.ingredientName}
              {line.prepTypeName && (
                <span className="text-muted-foreground">
                  , {line.prepTypeName}
                </span>
              )}
              {line.isOptional && (
                <span className="text-muted-foreground"> (optional)</span>
              )}
            </label>
          </li>
        );
      })}
    </ul>
  );
}
