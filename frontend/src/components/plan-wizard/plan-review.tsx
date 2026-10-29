import {
  anotherGoFormSchema,
  type AnotherGoForm,
  type HealthScoreAverage,
  type HouseholdMember,
  type PlanSlot,
  type ProposedFiguresInput,
} from '@loftys-larder/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { keepPreviousData } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';

import { ReviewSlotDialog } from '@/components/plan-wizard/review-slot-dialog.tsx';
import { ReviewSlotNote } from '@/components/plan-wizard/review-slot-note.tsx';
import { HealthScoreAverageBadge } from '@/components/planner/health-score-average-badge.tsx';
import { PlannerGrid } from '@/components/planner/planner-grid.tsx';
import { PlantPointsBadge } from '@/components/planner/plant-points-badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { eachDateInRange, formatDayRangeLabel } from '@/lib/date-utils.ts';
import {
  figuresInput,
  leftInPlan,
  reviewPlanSlots,
  setReviewStatus,
  slotKey,
  type ReviewState,
  type WizardInputs,
} from '@/lib/plan-wizard.ts';
import { deriveBaseBalances } from '@/lib/serving-variation-supply.ts';
import { trpc } from '@/lib/trpc.ts';

const FIGURES_DEBOUNCE_MS = 250;
const NO_HEALTH_SCORE: HealthScoreAverage = {
  average: null,
  notScored: 0,
  includesOutOfDate: false,
};

export interface PlanReviewProps {
  inputs: WizardInputs;
  review: ReviewState;
  members: readonly HouseholdMember[];
  onReviewChange: (review: ReviewState) => void;
  onAnotherGo: (note: string) => void;
  anotherGoPending: boolean;
  anotherGoError: string | null;
  offline?: boolean;
  onApply: () => void;
  applyPending: boolean;
  applyError: string | null;
  onBack: () => void;
}

export function PlanReview({
  inputs,
  review,
  members,
  onReviewChange,
  onAnotherGo,
  anotherGoPending,
  anotherGoError,
  offline = false,
  onApply,
  applyPending,
  applyError,
  onBack,
}: PlanReviewProps): React.ReactElement {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const reviewSlots = useMemo(
    () => reviewPlanSlots(inputs, review),
    [inputs, review],
  );
  const byId = useMemo(
    () => new Map(reviewSlots.map((entry) => [entry.slot.id, entry])),
    [reviewSlots],
  );
  const openSlot =
    openKey === null
      ? null
      : (reviewSlots.find(
          (entry) =>
            slotKey(entry.slot.date, entry.slot.occasionId) === openKey,
        ) ?? null);
  const balances = useMemo(
    () => deriveBaseBalances(reviewSlots.map((entry) => entry.slot)),
    [reviewSlots],
  );
  const leftOver = useMemo(
    () =>
      leftInPlan(
        reviewSlots.map((entry) => entry.slot),
        balances.remainingByBase,
      ),
    [reviewSlots, balances],
  );
  const busy = anotherGoPending || applyPending;

  const figuresRequest = useMemo(
    () => figuresInput(reviewSlots),
    [reviewSlots],
  );
  const figures = useProposedFigures(figuresRequest);
  const dates = useMemo(
    () => eachDateInRange(inputs.startDate, inputs.endDate),
    [inputs.startDate, inputs.endDate],
  );
  const { dayPlantCounts, dayHealthScores } = useMemo(() => {
    const plants = new Map<string, number | null>();
    const scores = new Map<string, HealthScoreAverage | null>();
    const byDate = new Map(figures?.days.map((day) => [day.date, day]));
    for (const date of dates) {
      const day = byDate.get(date);
      plants.set(date, figures ? (day?.plantPoints ?? 0) : null);
      scores.set(date, figures ? (day?.healthScore ?? NO_HEALTH_SCORE) : null);
    }
    return { dayPlantCounts: plants, dayHealthScores: scores };
  }, [figures, dates]);

  const form = useForm<AnotherGoForm>({
    resolver: zodResolver(anotherGoFormSchema),
    defaultValues: { note: '' },
  });
  const noteError = form.formState.errors.note;

  function update(key: string, next: Parameters<typeof setReviewStatus>[2]) {
    onReviewChange(setReviewStatus(review, key, next));
    setOpenKey(null);
  }

  return (
    <section aria-labelledby="plan-review-title" className="space-y-4">
      <header className="space-y-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-2">
          <h2 id="plan-review-title" className="text-lg font-semibold">
            Review {formatDayRangeLabel(inputs.startDate, inputs.endDate)}
          </h2>
          <PlantPointsBadge
            count={figures?.plan.plantPoints ?? null}
            variant="plan"
          />
          <HealthScoreAverageBadge
            value={figures?.plan.healthScore ?? null}
            variant="plan"
          />
        </div>
        <p className="text-sm text-muted-foreground">
          Every suggestion is kept unless you swap or discard it. Tap a meal to
          change it.
        </p>
        {review.summary && (
          <div className="rounded-lg border bg-card p-3 text-sm">
            <ReviewSlotNote kind="suggested" reason={null} />
            <p className="mt-1">{review.summary}</p>
          </div>
        )}
        {review.dropped > 0 && (
          <p role="status" className="text-sm text-muted-foreground">
            {review.dropped === 1
              ? '1 meal couldn’t be suggested and was left empty.'
              : `${String(review.dropped)} meals couldn’t be suggested and were left empty.`}
          </p>
        )}
        {leftOver.length > 0 && (
          <div className="text-sm">
            <p className="font-medium">Left in plan</p>
            <ul aria-label="Left in plan" className="text-muted-foreground">
              {leftOver.map((dish) => (
                <li key={dish.recipeId}>
                  {dish.recipeName}: {dish.portions} left in plan
                </li>
              ))}
            </ul>
          </div>
        )}
      </header>

      <PlannerGrid
        slots={reviewSlots.map((entry) => entry.slot)}
        members={members}
        rangeStart={inputs.startDate}
        rangeEnd={inputs.endDate}
        shortfallBySlot={balances.shortfallBySlot}
        shortfallByItem={balances.shortfallByItem}
        dayPlantCounts={dayPlantCounts}
        dayHealthScores={dayHealthScores}
        slotCommentLine={(slot: PlanSlot) => {
          const entry = byId.get(slot.id);
          return entry ? (
            <ReviewSlotNote kind={entry.kind} reason={entry.reason} />
          ) : null;
        }}
        onSlotClick={(slot) => {
          const entry = byId.get(slot.id);
          if (busy || !entry || entry.kind === 'fixed') return;
          if (entry.kind === 'unfilled' && !entry.canSwap) return;
          setOpenKey(slotKey(slot.date, slot.occasionId));
        }}
      />

      <form
        noValidate
        aria-label="Another go"
        onSubmit={(event) => {
          void form.handleSubmit((values) => {
            onAnotherGo(values.note);
            form.reset({ note: '' });
          })(event);
        }}
        className="space-y-2 rounded-lg border p-3"
      >
        <label htmlFor="plan-review-note" className="text-sm font-medium">
          Another go
        </label>
        <p className="text-xs text-muted-foreground">
          Replaces the suggestions you haven’t changed. Your swaps and discards
          stay.
        </p>
        <input
          id="plan-review-note"
          type="text"
          placeholder="Optional note, like “more veggie dinners”"
          aria-invalid={noteError ? true : undefined}
          disabled={busy}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          {...form.register('note')}
        />
        {noteError && (
          <p role="alert" className="text-sm text-destructive">
            {noteError.message}
          </p>
        )}
        {anotherGoError && (
          <p role="alert" className="text-sm text-destructive">
            {anotherGoError}
          </p>
        )}
        {offline && (
          <p className="text-sm text-muted-foreground">
            You’re offline. Planning with AI needs a connection.
          </p>
        )}
        <Button type="submit" variant="outline" disabled={busy || offline}>
          {anotherGoPending ? 'Planning again…' : 'Another go'}
        </Button>
      </form>

      {applyError && (
        <p role="alert" className="text-sm text-destructive">
          {applyError}
        </p>
      )}
      <div className="flex justify-between gap-2 border-t pt-4">
        <Button
          type="button"
          variant="outline"
          onClick={onBack}
          disabled={busy}
        >
          Back
        </Button>
        <Button type="button" onClick={onApply} disabled={busy}>
          {applyPending ? 'Creating plan…' : 'Apply'}
        </Button>
      </div>

      <ReviewSlotDialog
        reviewSlot={openSlot}
        onClose={() => {
          setOpenKey(null);
        }}
        onSwap={(recipe) => {
          if (openKey) update(openKey, { kind: 'swapped', recipe });
        }}
        onDiscard={() => {
          if (openKey) update(openKey, { kind: 'discarded' });
        }}
        onRestore={() => {
          if (openKey) update(openKey, { kind: 'suggested' });
        }}
      />
    </section>
  );
}

// The figures are worked out by rule on the server over the proposal as it
// stands (DEC-110 rule 3), refetched shortly after each change.
function useProposedFigures(input: ProposedFiguresInput) {
  const [debounced, setDebounced] = useState(input);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(input);
    }, FIGURES_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [input]);
  const query = trpc.plans.proposedFigures.useQuery(debounced, {
    placeholderData: keepPreviousData,
  });
  return query.data;
}
