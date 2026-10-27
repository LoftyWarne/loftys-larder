import type { HouseholdMember, PlanOccasion } from '@loftys-larder/shared';
import { useState } from 'react';

import { AttendanceEditor } from '@/components/plan-wizard/attendance-editor.tsx';
import { WizardStep } from '@/components/plan-wizard/wizard-step.tsx';
import { Button } from '@/components/ui/button.tsx';
import { formatLongDayLabel } from '@/lib/date-utils.ts';
import {
  groupByDate,
  headcount,
  NOBODY_EATING,
  resolveAttendance,
  type AttendanceSettings,
  type WizardSlotRef,
} from '@/lib/plan-wizard.ts';

export interface AttendanceStepProps {
  members: readonly HouseholdMember[];
  occasions: readonly PlanOccasion[];
  slots: readonly WizardSlotRef[];
  value: AttendanceSettings;
  onChange: (value: AttendanceSettings) => void;
  onBack: () => void;
  onNext: () => void;
}

export function AttendanceStep({
  members,
  occasions,
  slots,
  value,
  onChange,
  onBack,
  onNext,
}: AttendanceStepProps): React.ReactElement {
  const [editingKey, setEditingKey] = useState<string | null>(null);

  function setOccasion(occasionId: number, next: typeof value.all | null) {
    const byOccasion = new Map(value.byOccasion);
    if (next) byOccasion.set(occasionId, next);
    else byOccasion.delete(occasionId);
    onChange({ ...value, byOccasion });
  }

  function setSlot(key: string, next: typeof value.all | null) {
    const bySlot = new Map(value.bySlot);
    if (next) bySlot.set(key, next);
    else bySlot.delete(key);
    onChange({ ...value, bySlot });
  }

  const days = groupByDate(slots);

  return (
    <WizardStep
      step={2}
      title="Who’s eating?"
      description="Set it for every meal, then change an occasion or a single meal."
      nextLabel="Next"
      onBack={onBack}
      onNext={onNext}
    >
      <div className="space-y-6">
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Every meal</h3>
          <AttendanceEditor
            label="every meal"
            members={members}
            value={value.all}
            onChange={(all) => {
              onChange({ ...value, all });
            }}
          />
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold">By occasion</h3>
          {occasions.map((occasion) => {
            const override = value.byOccasion.get(occasion.id);
            return (
              <div key={occasion.id} className="space-y-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={override !== undefined}
                    onChange={() => {
                      setOccasion(occasion.id, override ? null : value.all);
                    }}
                  />
                  Different for {occasion.name}
                </label>
                {override && (
                  <AttendanceEditor
                    label={occasion.name}
                    members={members}
                    value={override}
                    onChange={(next) => {
                      setOccasion(occasion.id, next);
                    }}
                  />
                )}
              </div>
            );
          })}
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Each meal</h3>
          <ol className="space-y-3">
            {days.map(([date, daySlots]) => (
              <li key={date} className="rounded-lg border px-3 py-2">
                <h4 className="pb-1 text-sm font-medium">
                  {formatLongDayLabel(date)}
                </h4>
                <ul className="divide-y">
                  {daySlots.map((slot) => {
                    const attendance = resolveAttendance(
                      value,
                      slot.date,
                      slot.occasionId,
                    );
                    const count = headcount(attendance);
                    const overridden = value.bySlot.has(slot.key);
                    const editing = editingKey === slot.key;
                    const label = `${slot.occasionName}, ${formatLongDayLabel(slot.date)}`;
                    return (
                      <li key={slot.key} className="space-y-2 py-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-sm">
                            {slot.occasionName}{' '}
                            <span className="text-muted-foreground">
                              {count === 0
                                ? 'Nobody eating'
                                : `${String(count)} eating`}
                            </span>
                          </span>
                          <span className="flex gap-1">
                            {count > 0 && (
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                aria-label={`Nobody eating, ${label}`}
                                onClick={() => {
                                  setSlot(slot.key, NOBODY_EATING);
                                }}
                              >
                                Nobody
                              </Button>
                            )}
                            {overridden && (
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                aria-label={`Reset, ${label}`}
                                onClick={() => {
                                  setSlot(slot.key, null);
                                  if (editing) setEditingKey(null);
                                }}
                              >
                                Reset
                              </Button>
                            )}
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              aria-expanded={editing}
                              aria-label={`${editing ? 'Done' : 'Change'}, ${label}`}
                              onClick={() => {
                                setEditingKey(editing ? null : slot.key);
                              }}
                            >
                              {editing ? 'Done' : 'Change'}
                            </Button>
                          </span>
                        </div>
                        {editing && (
                          <AttendanceEditor
                            label={label}
                            members={members}
                            value={attendance}
                            onChange={(next) => {
                              setSlot(slot.key, next);
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
        </section>
      </div>
    </WizardStep>
  );
}
