import type { RecipeMethodStep } from '@loftys-larder/shared';

import { MethodStepBody } from '@/components/method-step-body.tsx';
import type { StepIngredientChip } from '@/lib/step-ingredient-amounts.ts';
import { mentionsQuantity } from '@/lib/step-highlights.ts';

interface StepScreenProps {
  step: RecipeMethodStep;
  chips: readonly StepIngredientChip[];
  factor: number;
  baseServings: number;
  ingredientNames: readonly string[];
  unitNames: readonly string[];
}

// One method step in cook mode (DEC-116), large. As on the recipe page,
// amounts written in the step aren't bolded or rewritten while scaled, and a
// note says they're for the original servings (DEC-98).
export function StepScreen({
  step,
  chips,
  factor,
  baseServings,
  ingredientNames,
  unitNames,
}: StepScreenProps): React.ReactElement {
  const isScaled = factor !== 1;
  return (
    <div>
      {isScaled && mentionsQuantity(step.instruction, unitNames) && (
        <p className="mb-3 text-sm text-muted-foreground">
          Amounts written in this step are for the original{' '}
          {String(baseServings)} servings.
        </p>
      )}
      <MethodStepBody
        step={step}
        chips={chips}
        factor={factor}
        ingredientNames={ingredientNames}
        unitNames={unitNames}
        boldQuantities={!isScaled}
        size="large"
      />
    </div>
  );
}
