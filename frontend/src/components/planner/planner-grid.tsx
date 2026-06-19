import type { PlanSlot } from '@loftys-larder/shared';
import { useMemo } from 'react';

import { BatchWarning } from '@/components/planner/batch-warning.tsx';
import { SlotCell } from '@/components/planner/slot-cell.tsx';
import { eachDateInRange, formatDayLabel } from '@/lib/date-utils.ts';

export interface PlannerGridProps {
  slots: readonly PlanSlot[];
  rangeStart: string;
  rangeEnd: string;
  warningSlotIds?: ReadonlySet<number>;
  dndEnabled?: boolean;
  onSlotClick: (slot: PlanSlot) => void;
  onSlotClear?: (slot: PlanSlot) => void;
}

interface OccasionColumn {
  id: number;
  name: string;
}

export function PlannerGrid({
  slots,
  rangeStart,
  rangeEnd,
  warningSlotIds,
  dndEnabled = false,
  onSlotClick,
  onSlotClear,
}: PlannerGridProps): React.ReactElement {
  const visibleDates = useMemo(
    () => eachDateInRange(rangeStart, rangeEnd),
    [rangeStart, rangeEnd],
  );

  const occasions = useMemo<OccasionColumn[]>(() => {
    const seen = new Map<number, string>();
    for (const slot of slots) {
      if (!seen.has(slot.occasionId)) {
        seen.set(slot.occasionId, slot.occasionName);
      }
    }
    return Array.from(seen, ([id, name]) => ({ id, name })).sort(
      (a, b) => a.id - b.id,
    );
  }, [slots]);

  const slotIndex = useMemo(() => {
    const map = new Map<string, PlanSlot>();
    for (const slot of slots) {
      map.set(slotKey(slot.date, slot.occasionId), slot);
    }
    return map;
  }, [slots]);

  if (occasions.length === 0 || visibleDates.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        No slots in the visible range.
      </p>
    );
  }

  return (
    <div role="table" aria-label="Meal plan" className="w-full overflow-x-auto">
      <div
        role="rowgroup"
        className="grid gap-2"
        style={{
          gridTemplateColumns: `minmax(6rem, max-content) repeat(${String(
            occasions.length,
          )}, minmax(10rem, 1fr))`,
        }}
      >
        <div role="row" className="contents">
          <div role="columnheader" />
          {occasions.map((occasion) => (
            <div
              key={occasion.id}
              role="columnheader"
              className="px-2 text-sm font-semibold"
            >
              {occasion.name}
            </div>
          ))}
        </div>
        {visibleDates.map((date) => (
          <div role="row" key={date} className="contents">
            <div
              role="rowheader"
              className="px-2 py-1 text-sm font-medium text-muted-foreground"
            >
              {formatDayLabel(date)}
            </div>
            {occasions.map((occasion) => {
              const slot = slotIndex.get(slotKey(date, occasion.id));
              return (
                <div role="cell" key={`${date}:${String(occasion.id)}`}>
                  {slot ? (
                    <SlotCell
                      slot={slot}
                      dndEnabled={dndEnabled}
                      baseCookLine={renderBaseCookLine(
                        slot,
                        warningSlotIds?.has(slot.id) ?? false,
                      )}
                      onClick={() => {
                        onSlotClick(slot);
                      }}
                      onClear={
                        onSlotClear
                          ? () => {
                              onSlotClear(slot);
                            }
                          : undefined
                      }
                    />
                  ) : (
                    <div className="h-full min-h-20 rounded-md border border-dashed border-input bg-muted/30" />
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function slotKey(date: string, occasionId: number): string {
  return `${date}:${String(occasionId)}`;
}

function renderBaseCookLine(
  slot: PlanSlot,
  showWarning: boolean,
): React.ReactNode {
  const hasBaseCook =
    slot.cooksBaseRecipeId !== null && slot.cooksBaseServings !== null;
  if (!hasBaseCook && !showWarning) return null;
  return (
    <div className="flex flex-col gap-0.5">
      {hasBaseCook && (
        <span className="text-xs text-muted-foreground">
          Cook base:{' '}
          {slot.cooksBaseRecipe?.name ?? `#${String(slot.cooksBaseRecipeId)}`}
          {slot.cooksBaseRecipe?.isDeleted && (
            <span className="ml-1 text-muted-foreground/70">(deleted)</span>
          )}{' '}
          (×{String(slot.cooksBaseServings)})
        </span>
      )}
      {showWarning && <BatchWarning />}
    </div>
  );
}
