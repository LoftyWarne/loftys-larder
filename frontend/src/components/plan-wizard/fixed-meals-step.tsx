import { useState } from 'react';

import { RecipePicker } from '@/components/plan-wizard/recipe-picker.tsx';
import { WizardStep } from '@/components/plan-wizard/wizard-step.tsx';
import { Button } from '@/components/ui/button.tsx';
import { formatLongDayLabel } from '@/lib/date-utils.ts';
import {
  canFixRecipe,
  groupByDate,
  resolveAttendance,
  type AttendanceSettings,
  type FixedChoice,
  type WizardSlotRef,
} from '@/lib/plan-wizard.ts';

export interface FixedMealsStepProps {
  slots: readonly WizardSlotRef[];
  attendance: AttendanceSettings;
  value: ReadonlyMap<string, FixedChoice>;
  onChange: (value: ReadonlyMap<string, FixedChoice>) => void;
  onBack: () => void;
  onNext: () => void;
}

type FixedKind = 'none' | FixedChoice['kind'];

export function FixedMealsStep({
  slots,
  attendance,
  value,
  onChange,
  onBack,
  onNext,
}: FixedMealsStepProps): React.ReactElement {
  // Slots where the cook chose "A recipe" but hasn't picked one yet.
  const [picking, setPicking] = useState<ReadonlySet<string>>(new Set());

  function setFixed(key: string, choice: FixedChoice | null) {
    const next = new Map(value);
    if (choice) next.set(key, choice);
    else next.delete(key);
    onChange(next);
  }

  function setPickingFor(key: string, on: boolean) {
    setPicking((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  return (
    <WizardStep
      step={3}
      title="Any meals already decided?"
      description="The plan is made around these and never changes them."
      nextLabel="Next"
      onBack={onBack}
      onNext={onNext}
    >
      <ol className="space-y-3">
        {groupByDate(slots).map(([date, daySlots]) => (
          <li key={date} className="rounded-lg border px-3 py-2">
            <h3 className="pb-1 text-sm font-medium">
              {formatLongDayLabel(date)}
            </h3>
            <ul className="divide-y">
              {daySlots.map((slot) => {
                const choice = value.get(slot.key);
                const isPicking = picking.has(slot.key);
                const kind: FixedKind = isPicking
                  ? 'recipe'
                  : (choice?.kind ?? 'none');
                const recipeAllowed = canFixRecipe(
                  resolveAttendance(attendance, slot.date, slot.occasionId),
                );
                const label = `${slot.occasionName}, ${formatLongDayLabel(slot.date)}`;
                return (
                  <li key={slot.key} className="space-y-2 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm">{slot.occasionName}</span>
                      <select
                        aria-label={`Fixed meal, ${label}`}
                        value={kind}
                        onChange={(event) => {
                          const next = event.target.value as FixedKind;
                          setPickingFor(slot.key, next === 'recipe');
                          if (next === 'none' || next === 'recipe') {
                            setFixed(slot.key, null);
                          } else {
                            setFixed(slot.key, { kind: next });
                          }
                        }}
                        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                      >
                        <option value="none">Plan it for me</option>
                        <option value="recipe" disabled={!recipeAllowed}>
                          A recipe
                        </option>
                        <option value="eat_out">Eat out</option>
                        <option value="takeaway">Takeaway</option>
                      </select>
                    </div>
                    {!recipeAllowed && (
                      <p className="text-xs text-muted-foreground">
                        Nobody’s eating here, so it can’t be fixed to a recipe.
                      </p>
                    )}
                    {choice?.kind === 'recipe' && !isPicking && (
                      <div className="flex items-center justify-between gap-2 text-sm">
                        <span className="min-w-0 font-medium break-words">
                          {choice.recipe.name}
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-label={`Change recipe, ${label}`}
                          onClick={() => {
                            setPickingFor(slot.key, true);
                          }}
                        >
                          Change
                        </Button>
                      </div>
                    )}
                    {isPicking && (
                      <RecipePicker
                        ariaLabel={`Recipe, ${label}`}
                        onPick={(recipe) => {
                          setFixed(slot.key, { kind: 'recipe', recipe });
                          setPickingFor(slot.key, false);
                        }}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ol>
    </WizardStep>
  );
}
