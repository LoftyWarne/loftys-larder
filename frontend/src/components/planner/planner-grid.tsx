import type { HouseholdMember, PlanSlot } from '@loftys-larder/shared';
import { useMemo } from 'react';

import { PlantPointsBadge } from '@/components/planner/plant-points-badge.tsx';
import { SlotCell } from '@/components/planner/slot-cell.tsx';
import { SlotDinersChip } from '@/components/planner/slot-diners-chip.tsx';
import { eachDateInRange, formatDayLabel } from '@/lib/date-utils.ts';

export interface PlannerGridProps {
  slots: readonly PlanSlot[];
  // Household members, to resolve a slot's diner ids to names for the chip.
  members: readonly HouseholdMember[];
  rangeStart: string;
  rangeEnd: string;
  // Base-consumption shortfall per slot id (how many base servings short),
  // from `deriveBaseBalances`. Read-only, derived externally.
  shortfallBySlot?: ReadonlyMap<number, number>;
  /**
   * Plant-point totals keyed by civil date (`YYYY-MM-DD`). `null` for a date
   * means the count is loading; an absent key means "no opinion" (badge
   * hidden). Read-only, derived externally, no business logic in the grid.
   */
  dayPlantCounts?: ReadonlyMap<string, number | null>;
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
  members,
  rangeStart,
  rangeEnd,
  shortfallBySlot,
  dayPlantCounts,
  dndEnabled = false,
  onSlotClick,
  onSlotClear,
}: PlannerGridProps): React.ReactElement {
  const visibleDates = useMemo(
    () => eachDateInRange(rangeStart, rangeEnd),
    [rangeStart, rangeEnd],
  );

  const memberNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of members) map.set(member.id, member.name);
    return map;
  }, [members]);

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
          // Column minima are mobile-first: a phone at 360 px can fit a
          // 4rem date label + two 7rem occasion columns (18rem total) with
          // breathing room. Larger viewports expand via the 1fr terms.
          gridTemplateColumns: `minmax(4rem, max-content) repeat(${String(
            occasions.length,
          )}, minmax(7rem, 1fr))`,
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
              className="flex flex-col gap-1 px-2 py-1 text-sm font-medium text-muted-foreground"
            >
              <span>{formatDayLabel(date)}</span>
              {dayPlantCounts?.has(date) && (
                <PlantPointsBadge
                  count={dayPlantCounts.get(date) ?? null}
                  variant="day"
                />
              )}
            </div>
            {occasions.map((occasion) => {
              const slot = slotIndex.get(slotKey(date, occasion.id));
              return (
                <div role="cell" key={`${date}:${String(occasion.id)}`}>
                  {slot ? (
                    <SlotCell
                      slot={slot}
                      dndEnabled={dndEnabled}
                      shortBy={shortfallBySlot?.get(slot.id)}
                      chefChip={
                        <SlotDinersChip
                          dinerNames={slot.dinerUserIds.map(
                            (id) => memberNameById.get(id) ?? 'Unknown',
                          )}
                          guestCount={slot.guestCount}
                        />
                      }
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
