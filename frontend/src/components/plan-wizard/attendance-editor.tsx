import type { HouseholdMember } from '@loftys-larder/shared';

import { Input } from '@/components/ui/input.tsx';
import type { Attendance } from '@/lib/plan-wizard.ts';
import { cn } from '@/lib/utils.ts';

// Who's eating: household members and a guest count, as the slot editor
// records them.
export interface AttendanceEditorProps {
  label: string;
  members: readonly HouseholdMember[];
  value: Attendance;
  onChange: (value: Attendance) => void;
}

export function AttendanceEditor({
  label,
  members,
  value,
  onChange,
}: AttendanceEditorProps): React.ReactElement {
  return (
    <fieldset className="space-y-2">
      <legend className="sr-only">{label}</legend>
      {members.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {members.map((member) => {
            const selected = value.dinerUserIds.includes(member.id);
            return (
              <label
                key={member.id}
                className={cn(
                  'flex cursor-pointer items-center gap-1 rounded-md border border-input px-3 py-1 text-sm transition focus-within:ring-2 focus-within:ring-ring',
                  selected && 'border-primary bg-accent',
                )}
              >
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => {
                    onChange({
                      ...value,
                      dinerUserIds: selected
                        ? value.dinerUserIds.filter((id) => id !== member.id)
                        : [...value.dinerUserIds, member.id],
                    });
                  }}
                  className="sr-only"
                />
                {member.name}
              </label>
            );
          })}
        </div>
      )}
      <label className="flex items-center gap-2 text-sm">
        <span>Guests</span>
        <Input
          type="number"
          inputMode="numeric"
          min={0}
          value={String(value.guestCount)}
          aria-label={`Guests, ${label}`}
          onChange={(event) => {
            const parsed = Number.parseInt(event.target.value, 10);
            onChange({
              ...value,
              guestCount: Number.isFinite(parsed) ? Math.max(0, parsed) : 0,
            });
          }}
          className="w-20"
        />
      </label>
    </fieldset>
  );
}
