import type { RecipeMethodStep } from '@loftys-larder/shared';

import { PrepAheadBadge } from '@/components/prep-ahead-badge.tsx';
import { StepIngredientChips } from '@/components/step-ingredient-chips.tsx';
import { StepInstruction } from '@/components/step-instruction.tsx';
import { StepNoteCallout } from '@/components/step-note-callout.tsx';
import type { StepIngredientChip } from '@/lib/step-ingredient-amounts.ts';
import { cn } from '@/lib/utils.ts';

interface MethodStepBodyProps {
  step: RecipeMethodStep;
  chips: readonly StepIngredientChip[];
  factor: number;
  ingredientNames: readonly string[];
  unitNames: readonly string[];
  boldQuantities: boolean;
  size?: 'default' | 'large';
}

// One method step as the recipe page and cook mode show it: its prep-ahead
// badge (DEC-96), highlighted text (DEC-95), ingredient chips (DEC-99) and
// notes (DEC-94). Cook mode renders it large (DEC-116).
export function MethodStepBody({
  step,
  chips,
  factor,
  ingredientNames,
  unitNames,
  boldQuantities,
  size = 'default',
}: MethodStepBodyProps): React.ReactElement {
  const isLarge = size === 'large';
  return (
    <>
      {step.prepAhead !== null && (
        <PrepAheadBadge
          prepAhead={step.prepAhead}
          className={cn('mb-1 flex w-fit', isLarge && 'mb-3 text-sm')}
        />
      )}
      <span className={cn(isLarge && 'block text-2xl leading-snug')}>
        <StepInstruction
          text={step.instruction}
          ingredientNames={ingredientNames}
          unitNames={unitNames}
          boldQuantities={boldQuantities}
        />
      </span>
      <StepIngredientChips
        stepNumber={step.stepNumber}
        chips={chips}
        factor={factor}
        size={size}
      />
      {(step.safetyNote !== null || step.tip !== null) && (
        <div className={cn('mt-2 space-y-2', isLarge && 'mt-4')}>
          {step.safetyNote !== null && (
            <StepNoteCallout
              kind="safety"
              className={cn(isLarge && 'text-base')}
            >
              <p>{step.safetyNote}</p>
            </StepNoteCallout>
          )}
          {step.tip !== null && (
            <StepNoteCallout kind="tip" className={cn(isLarge && 'text-base')}>
              <p>{step.tip}</p>
            </StepNoteCallout>
          )}
        </div>
      )}
    </>
  );
}
