import type { RecipeMethodStep, StepPrepAhead } from '@loftys-larder/shared';

import { PREP_AHEAD_STYLES } from '@/components/prep-ahead-badge.tsx';
import { StepInstruction } from '@/components/step-instruction.tsx';
import { cn } from '@/lib/utils.ts';

interface PlanAheadSummaryProps {
  method: readonly RecipeMethodStep[];
  ingredientNames: readonly string[];
  unitNames: readonly string[];
  boldQuantities?: boolean;
}

const GROUP_ORDER: readonly StepPrepAhead[] = ['required', 'optional'];

export function PlanAheadSummary({
  method,
  ingredientNames,
  unitNames,
  boldQuantities,
}: PlanAheadSummaryProps): React.ReactElement | null {
  const groups = GROUP_ORDER.map((prepAhead) => ({
    prepAhead,
    steps: method.filter((step) => step.prepAhead === prepAhead),
  })).filter((group) => group.steps.length > 0);

  if (groups.length === 0) return null;

  return (
    <section className="space-y-2" aria-labelledby="plan-ahead-heading">
      <h2 id="plan-ahead-heading" className="text-xl font-semibold">
        Plan ahead
      </h2>
      {groups.map(({ prepAhead, steps }) => {
        const { label, Icon, className } = PREP_AHEAD_STYLES[prepAhead];
        const headingId = `plan-ahead-${prepAhead}-heading`;
        return (
          <div
            key={prepAhead}
            className={cn('space-y-1 rounded-md border px-3 py-2', className)}
            aria-labelledby={headingId}
            role="group"
          >
            <p
              id={headingId}
              className="flex items-center gap-1.5 text-sm font-medium"
            >
              <Icon aria-hidden className="size-4 shrink-0" />
              {label}
            </p>
            <ul className="space-y-1 text-sm">
              {steps.map((step) => (
                <li key={step.id}>
                  <span className="font-medium">Step {step.stepNumber}:</span>{' '}
                  <StepInstruction
                    text={step.instruction}
                    ingredientNames={ingredientNames}
                    unitNames={unitNames}
                    boldQuantities={boldQuantities}
                  />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
