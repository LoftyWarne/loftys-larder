import { MEAL_PLAN_BATCH_MAX_PORTIONS } from '@loftys-larder/shared';
import { useState } from 'react';

import { RecipePicker } from '@/components/plan-wizard/recipe-picker.tsx';
import { WizardStep } from '@/components/plan-wizard/wizard-step.tsx';
import { Button } from '@/components/ui/button.tsx';
import { formatLongDayLabel } from '@/lib/date-utils.ts';
import {
  batchPortionsError,
  canFixRecipe,
  groupByDate,
  headcount,
  invalidBatches,
  resolveAttendance,
  type AttendanceSettings,
  type FixedChoice,
  type RecipeChoice,
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
type PickingKind = 'recipe' | 'batch';

// Enough for the slot and as many again, or a few where nobody eats.
function defaultBatchPortions(eating: number): number {
  return eating > 0 ? eating * 2 : 4;
}

export function FixedMealsStep({
  slots,
  attendance,
  value,
  onChange,
  onBack,
  onNext,
}: FixedMealsStepProps): React.ReactElement {
  // Slots where the cook is picking the recipe for "A recipe" or "A batch".
  const [picking, setPicking] = useState<ReadonlyMap<string, PickingKind>>(
    new Map(),
  );
  const invalid = invalidBatches({ attendance, fixed: value }, slots);

  function setFixed(key: string, choice: FixedChoice | null) {
    const next = new Map(value);
    if (choice) next.set(key, choice);
    else next.delete(key);
    onChange(next);
  }

  function setPickingFor(key: string, kind: PickingKind | null) {
    setPicking((prev) => {
      const next = new Map(prev);
      if (kind) next.set(key, kind);
      else next.delete(key);
      return next;
    });
  }

  function pick(
    key: string,
    kind: PickingKind,
    recipe: RecipeChoice,
    eating: number,
  ) {
    if (kind === 'recipe') {
      setFixed(key, { kind: 'recipe', recipe });
    } else {
      const current = value.get(key);
      const portions =
        current?.kind === 'batch'
          ? current.portions
          : defaultBatchPortions(eating);
      setFixed(key, { kind: 'batch', recipe, portions });
    }
    setPickingFor(key, null);
  }

  return (
    <WizardStep
      step={3}
      title="Any meals already decided?"
      description="The plan is made around these and never changes them."
      nextLabel="Next"
      nextDisabled={invalid.length > 0}
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
                const pickingKind = picking.get(slot.key);
                const kind: FixedKind = pickingKind ?? choice?.kind ?? 'none';
                const slotAttendance = resolveAttendance(
                  attendance,
                  slot.date,
                  slot.occasionId,
                );
                const eating = headcount(slotAttendance);
                const recipeAllowed = canFixRecipe(slotAttendance);
                const label = `${slot.occasionName}, ${formatLongDayLabel(slot.date)}`;
                const portionsId = `fixed-portions-${slot.key}`;
                const portionsError =
                  choice?.kind === 'batch'
                    ? batchPortionsError(choice.portions, slotAttendance)
                    : null;
                return (
                  <li key={slot.key} className="space-y-2 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm">{slot.occasionName}</span>
                      <select
                        aria-label={`Fixed meal, ${label}`}
                        value={kind}
                        onChange={(event) => {
                          const next = event.target.value as FixedKind;
                          if (next === 'recipe' || next === 'batch') {
                            setPickingFor(slot.key, next);
                            setFixed(slot.key, null);
                            return;
                          }
                          setPickingFor(slot.key, null);
                          setFixed(
                            slot.key,
                            next === 'none' ? null : { kind: next },
                          );
                        }}
                        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                      >
                        <option value="none">Plan it for me</option>
                        <option value="recipe" disabled={!recipeAllowed}>
                          A recipe
                        </option>
                        <option value="batch">A batch to cook</option>
                        <option value="eat_out">Eat out</option>
                        <option value="takeaway">Takeaway</option>
                      </select>
                    </div>
                    {!recipeAllowed && (
                      <p className="text-xs text-muted-foreground">
                        Nobody’s eating here, so it can’t be fixed to a recipe.
                        A batch is cooked here for later.
                      </p>
                    )}
                    {(choice?.kind === 'recipe' || choice?.kind === 'batch') &&
                      !pickingKind && (
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
                              setPickingFor(slot.key, choice.kind);
                            }}
                          >
                            Change
                          </Button>
                        </div>
                      )}
                    {choice?.kind === 'batch' && !pickingKind && (
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <label htmlFor={portionsId} className="text-sm">
                            Portions cooked
                          </label>
                          <input
                            id={portionsId}
                            type="number"
                            inputMode="numeric"
                            min={Math.max(eating, 1)}
                            max={MEAL_PLAN_BATCH_MAX_PORTIONS}
                            value={
                              Number.isNaN(choice.portions)
                                ? ''
                                : String(choice.portions)
                            }
                            aria-invalid={portionsError ? true : undefined}
                            aria-describedby={`${portionsId}-hint`}
                            onChange={(event) => {
                              setFixed(slot.key, {
                                ...choice,
                                portions: Number.parseInt(
                                  event.target.value,
                                  10,
                                ),
                              });
                            }}
                            className="h-9 w-20 rounded-md border border-input bg-background px-2 text-sm"
                          />
                        </div>
                        <p
                          id={`${portionsId}-hint`}
                          className={
                            portionsError
                              ? 'text-xs text-destructive'
                              : 'text-xs text-muted-foreground'
                          }
                        >
                          {portionsError ??
                            (eating > 0
                              ? `${String(eating)} eat it here. The rest is planned for later in the plan.`
                              : 'Nobody eats it here. It’s all planned for later in the plan.')}
                        </p>
                      </div>
                    )}
                    {pickingKind && (
                      <RecipePicker
                        ariaLabel={`Recipe, ${label}`}
                        onPick={(recipe) => {
                          pick(slot.key, pickingKind, recipe, eating);
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
