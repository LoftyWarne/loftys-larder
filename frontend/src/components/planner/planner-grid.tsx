import type {
  HealthScoreAverage,
  HouseholdMember,
  PlanSlot,
} from '@loftys-larder/shared';
import { useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';

import { PlannerDayCard } from '@/components/planner/planner-day-card.tsx';
import { HealthScoreAverageBadge } from '@/components/planner/health-score-average-badge.tsx';
import { PlantPointsBadge } from '@/components/planner/plant-points-badge.tsx';
import { SlotCell } from '@/components/planner/slot-cell.tsx';
import { SlotDinersChip } from '@/components/planner/slot-diners-chip.tsx';
import { useIsMediumViewport } from '@/hooks/use-is-large-viewport.ts';
import {
  eachDateInRange,
  formatDayLabel,
  todayInLondon,
} from '@/lib/date-utils.ts';

export interface PlannerGridProps {
  slots: readonly PlanSlot[];
  // Household members, to resolve a slot's diner ids to names for the chip.
  members: readonly HouseholdMember[];
  rangeStart: string;
  rangeEnd: string;
  // Base-consumption shortfall per slot id (how many base servings short),
  // from `deriveBaseBalances`. Read-only, derived externally.
  shortfallBySlot?: ReadonlyMap<number, number>;
  // The same shortfall attributed to the specific dish (slot-item id), so the
  // card can show the nudge under the dish in question.
  shortfallByItem?: ReadonlyMap<number, number>;
  /**
   * Plant-point totals keyed by civil date (`YYYY-MM-DD`). `null` for a date
   * means the count is loading; an absent key means "no opinion" (badge
   * hidden). Read-only, derived externally, no business logic in the grid.
   */
  dayPlantCounts?: ReadonlyMap<string, number | null>;
  /** Day Health Scores (DEC-113), with the same keys contract as above. */
  dayHealthScores?: ReadonlyMap<string, HealthScoreAverage | null>;
  dndEnabled?: boolean;
  // Fills the slot card's comment region (cross-cutting #14) in place of the
  // slot's comment; Plan Review shows the AI badge and reason there.
  slotCommentLine?: (slot: PlanSlot) => ReactNode;
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
  shortfallByItem,
  dayPlantCounts,
  dayHealthScores,
  dndEnabled = false,
  slotCommentLine,
  onSlotClick,
  onSlotClear,
}: PlannerGridProps): React.ReactElement {
  // Below `md` the grid gives way to one card per day (FEAT-72, DEC-115). Only
  // one layout mounts, so each slot registers its dnd-kit ids once.
  const isMediumViewport = useIsMediumViewport();
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

  function renderSlot(date: string, occasionId: number): ReactNode {
    const slot = slotIndex.get(slotKey(date, occasionId));
    if (!slot) {
      return (
        <div className="h-full min-h-20 rounded-md border border-dashed border-input bg-muted/30" />
      );
    }
    return (
      <SlotCell
        slot={slot}
        dndEnabled={dndEnabled}
        shortBy={shortfallBySlot?.get(slot.id)}
        shortfallByItem={shortfallByItem}
        chefChip={
          <SlotDinersChip
            dinerNames={slot.dinerUserIds.map(
              (id) => memberNameById.get(id) ?? 'Unknown',
            )}
            guestCount={slot.guestCount}
          />
        }
        commentLine={slotCommentLine?.(slot)}
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
    );
  }

  if (!isMediumViewport) {
    return (
      <PlannerDayList
        dates={visibleDates}
        occasions={occasions}
        dayPlantCounts={dayPlantCounts}
        dayHealthScores={dayHealthScores}
        renderSlot={renderSlot}
      />
    );
  }

  return (
    <div role="table" aria-label="Meal plan" className="w-full overflow-x-auto">
      <div
        role="rowgroup"
        className="grid gap-2"
        style={{
          // Column minima: a 4rem date label + 7rem per occasion. Below `md`
          // the day list takes over, so these only need to fit a tablet.
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
              {dayHealthScores?.has(date) && (
                <HealthScoreAverageBadge
                  value={dayHealthScores.get(date) ?? null}
                  variant="day"
                />
              )}
            </div>
            {occasions.map((occasion) => (
              <div role="cell" key={`${date}:${String(occasion.id)}`}>
                {renderSlot(date, occasion.id)}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function PlannerDayList({
  dates,
  occasions,
  dayPlantCounts,
  dayHealthScores,
  renderSlot,
}: {
  dates: readonly string[];
  occasions: readonly OccasionColumn[];
  dayPlantCounts?: ReadonlyMap<string, number | null>;
  dayHealthScores?: ReadonlyMap<string, HealthScoreAverage | null>;
  renderSlot: (date: string, occasionId: number) => ReactNode;
}): React.ReactElement {
  const today = todayInLondon();
  const todayRef = useRef<HTMLElement>(null);

  // Land on today once, on mount. Later renders (slot edits, refetches) must
  // not yank the page back. When today is the first day the page is already
  // there, and scrolling would only hide the plan header.
  useEffect(() => {
    todayRef.current?.scrollIntoView({ block: 'start' });
  }, []);

  return (
    <ol aria-label="Meal plan" className="flex flex-col gap-3">
      {dates.map((date, index) => (
        <li key={date}>
          <PlannerDayCard
            ref={date === today && index > 0 ? todayRef : undefined}
            date={date}
            isToday={date === today}
            occasions={occasions}
            plantCount={
              dayPlantCounts?.has(date)
                ? (dayPlantCounts.get(date) ?? null)
                : undefined
            }
            healthScore={
              dayHealthScores?.has(date)
                ? (dayHealthScores.get(date) ?? null)
                : undefined
            }
            renderSlot={(occasionId) => renderSlot(date, occasionId)}
          />
        </li>
      ))}
    </ol>
  );
}

function slotKey(date: string, occasionId: number): string {
  return `${date}:${String(occasionId)}`;
}
