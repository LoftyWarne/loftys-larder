import type { PlanSlot } from '@loftys-larder/shared';
import { Link } from '@tanstack/react-router';

import { Button } from '@/components/ui/button.tsx';
import {
  formatDayLabel,
  hourInLondon,
  todayInLondon,
} from '@/lib/date-utils.ts';
import { trpc } from '@/lib/trpc.ts';

function greeting(name: string | undefined): string {
  const hour = hourInLondon();
  const timeOfDay = hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening';
  return name ? `${timeOfDay}, ${name}` : "Lofty's Larder";
}

// A slot counts as "planned" when it carries any commitment — a (live) recipe
// or an eat-out / takeaway / leftovers marker. Empty slots, and the rare
// recipe slot whose recipe row vanished, are treated as unplanned.
function isPlanned(slot: PlanSlot): boolean {
  if (slot.slotType === 'empty') return false;
  if (slot.slotType === 'recipe' && !slot.recipe) return false;
  return true;
}

// Label for a slot on the home lists. Recipe names stay plain text (DEC-49).
// A recipe soft-deleted after assignment still renders, tagged "(deleted)"
// for historical coherence (DEC-21).
function slotSummaryLabel(slot: PlanSlot): string {
  switch (slot.slotType) {
    case 'recipe':
      if (!slot.recipe) return '— not planned —';
      return slot.recipe.isDeleted
        ? `${slot.recipe.name} (deleted)`
        : slot.recipe.name;
    case 'eat_out':
      return 'Eat out';
    case 'takeaway':
      return 'Takeaway';
    case 'leftovers':
      return 'Leftovers';
    case 'empty':
    default:
      return '— not planned —';
  }
}

// One occasion row. A live recipe links through to its detail page; everything
// else (markers, deleted recipes, empty occasions) is plain text.
function MealRow({ slot }: { slot: PlanSlot }): React.ReactElement {
  const recipe = slot.slotType === 'recipe' ? slot.recipe : null;
  const linkable = recipe !== null && !recipe.isDeleted;
  return (
    <li className="flex items-center justify-between gap-4 px-4 py-2">
      <span className="text-sm font-medium">{slot.occasionName}</span>
      {linkable ? (
        <Link
          to="/recipes/$recipeId"
          params={{ recipeId: String(recipe.id) }}
          className="text-sm text-primary hover:underline"
        >
          {recipe.name}
        </Link>
      ) : (
        <span
          className={
            isPlanned(slot) ? 'text-sm' : 'text-sm text-muted-foreground'
          }
        >
          {slotSummaryLabel(slot)}
        </span>
      )}
    </li>
  );
}

function QuickActions(): React.ReactElement {
  return (
    <div className="flex flex-wrap gap-2">
      <Button asChild>
        <Link to="/plans">New plan</Link>
      </Button>
      <Button asChild variant="outline">
        <Link to="/recipes">Browse recipes</Link>
      </Button>
    </div>
  );
}

const SECTION_LABEL =
  'text-xs font-semibold uppercase tracking-wide text-muted-foreground';

export function IndexPage(): React.ReactElement {
  const me = trpc.user.getMe.useQuery();
  const activePlans = trpc.plans.list.useQuery({ status: 'active' });
  const activePlan = activePlans.data?.items[0];
  const planId = activePlan?.id;

  const planDetail = trpc.plans.get.useQuery(
    { id: planId ?? 0 },
    { enabled: planId !== undefined },
  );

  const today = todayInLondon();
  const slots = planDetail.data?.slots ?? [];

  const byOccasion = (a: PlanSlot, b: PlanSlot): number =>
    a.occasionId - b.occasionId;

  const todaysSlots = slots
    .filter((slot) => slot.date === today)
    .sort(byOccasion);

  // Remaining days in the plan, each carrying only its planned meals. Days with
  // nothing planned still appear so the week reads as a continuous run.
  const upcomingDates = [
    ...new Set(slots.filter((slot) => slot.date > today).map((s) => s.date)),
  ].sort();
  const upcomingDays = upcomingDates.map((date) => ({
    date,
    meals: slots
      .filter((slot) => slot.date === date && isPlanned(slot))
      .sort(byOccasion),
  }));

  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">{greeting(me.data?.name)}</h1>

      {activePlans.isLoading && <p role="status">Loading your plan…</p>}

      {activePlans.error && (
        <p role="alert" className="text-sm text-destructive">
          Could not load your plan: {activePlans.error.message}
        </p>
      )}

      {!activePlans.isLoading && !activePlans.error && !activePlan && (
        <article className="space-y-4 rounded-md border p-4">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">No active plan</h2>
            <p className="text-sm text-muted-foreground">
              Nothing planned for right now. Create a plan to start planning
              meals and building a shopping list.
            </p>
          </div>
          <QuickActions />
        </article>
      )}

      {activePlan && (
        <>
          {/* Today — the focus day, showing every occasion. */}
          <section className="space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <p className={SECTION_LABEL}>Today</p>
              <span className="text-xs text-muted-foreground">
                {formatDayLabel(today)}
              </span>
            </div>
            {planDetail.isLoading && (
              <p role="status" className="text-sm text-muted-foreground">
                Loading today’s meals…
              </p>
            )}
            {!planDetail.isLoading && todaysSlots.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No meal occasions fall on today.
              </p>
            )}
            {todaysSlots.length > 0 && (
              <ul className="divide-y rounded-md border">
                {todaysSlots.map((slot) => (
                  <MealRow key={slot.id} slot={slot} />
                ))}
              </ul>
            )}
          </section>

          {/* Coming up — the rest of the plan, planned meals only. */}
          {upcomingDays.length > 0 && (
            <section className="space-y-3">
              <p className={SECTION_LABEL}>Coming up</p>
              <div className="space-y-3">
                {upcomingDays.map(({ date, meals }) => (
                  <div key={date} className="rounded-md border">
                    <p className="border-b px-4 py-1.5 text-xs font-medium text-muted-foreground">
                      {formatDayLabel(date)}
                    </p>
                    {meals.length > 0 ? (
                      <ul className="divide-y">
                        {meals.map((slot) => (
                          <MealRow key={slot.id} slot={slot} />
                        ))}
                      </ul>
                    ) : (
                      <p className="px-4 py-2 text-sm text-muted-foreground">
                        — not planned —
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Primary navigation lives at the foot of the page. */}
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link
                to="/plans/$planId"
                params={{ planId: String(activePlan.id) }}
              >
                Open planner
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/shopping">Shopping list</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/plans">New plan</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/recipes">Browse recipes</Link>
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
