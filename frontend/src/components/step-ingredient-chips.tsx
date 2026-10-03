import { formatScaledQuantity } from '@/lib/scale-quantity.ts';
import type { StepIngredientChip } from '@/lib/step-ingredient-amounts.ts';
import { cn } from '@/lib/utils.ts';

interface StepIngredientChipsProps {
  stepNumber: number;
  chips: readonly StepIngredientChip[];
  factor: number;
}

// The ingredients a method step uses, as chips under its text (DEC-99).
// Amounts scale with the portions stepper (DEC-98).
export function StepIngredientChips({
  stepNumber,
  chips,
  factor,
}: StepIngredientChipsProps): React.ReactElement | null {
  if (chips.length === 0) return null;
  return (
    <ul
      aria-label={`Step ${String(stepNumber)} ingredients`}
      className="mt-2 flex flex-wrap gap-1.5"
    >
      {chips.map((chip) => (
        <li
          key={chip.ingredientId}
          className={cn(
            'rounded-full border px-2.5 py-0.5 text-xs',
            chip.isOptional && 'border-dashed',
          )}
        >
          {chip.amount !== null && (
            <span className="font-semibold">
              {formatScaledQuantity(chip.amount, chip.unitName, factor)}{' '}
              {chip.unitName}{' '}
            </span>
          )}
          {chip.name}
          {chip.isOptional && (
            <span className="text-muted-foreground"> (optional)</span>
          )}
        </li>
      ))}
    </ul>
  );
}
