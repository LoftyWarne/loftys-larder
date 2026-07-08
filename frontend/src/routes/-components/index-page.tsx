import type { PlanSlot } from '@loftys-larder/shared';
import { Link } from '@tanstack/react-router';

import { SlotCommentLine } from '@/components/planner/slot-comment-line.tsx';
import { SlotDinersChip } from '@/components/planner/slot-diners-chip.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  formatDayLabel,
  hourInLondon,
  todayInLondon,
} from '@/lib/date-utils.ts';
import { dishQtyLabel, leftoversSummary } from '@/lib/slot-display.ts';
import { trpc } from '@/lib/trpc.ts';

function greeting(name: string | undefined): string {
  const hour = hourInLondon();
  const timeOfDay = hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening';
  return name ? `${timeOfDay}, ${name}` : "Lofty's Larder";
}

function eatItems(slot: PlanSlot): PlanSlot['items'] {
  return slot.items.filter((item) => item.eaten > 0);
}

// A slot counts as "planned" when it carries any commitment — at least one
// eaten dish or an eat-out / takeaway / leftovers marker. Empty slots, and a
// recipe slot whose dishes vanished, are treated as unplanned.
function isPlanned(slot: PlanSlot): boolean {
  if (slot.slotType === 'empty') return false;
  if (slot.slotType === 'recipe') return eatItems(slot).length > 0;
  return true;
}

// A dish's quantity, shown muted alongside its name.
function DishQty({
  item,
}: {
  item: PlanSlot['items'][number];
}): React.ReactElement {
  return (
    <span className="ml-1 text-xs text-muted-foreground">
      {dishQtyLabel(item)}
    </span>
  );
}

// A dish name, linking through to its recipe detail page. A recipe soft-deleted
// after assignment renders tagged "(deleted)" (DEC-21) and never links — there's
// no live recipe to open. Names stay plain text (DEC-49).
function RecipeName({
  item,
}: {
  item: PlanSlot['items'][number];
}): React.ReactElement {
  if (item.isDeleted) {
    return (
      <>
        {item.recipeName}
        <span className="ml-1 text-xs text-muted-foreground">(deleted)</span>
      </>
    );
  }
  return (
    <Link
      to="/recipes/$recipeId"
      params={{ recipeId: String(item.recipeId) }}
      className="font-medium text-primary underline-offset-2 hover:underline focus-visible:underline"
    >
      {item.recipeName}
    </Link>
  );
}

// The right-hand meal summary for a slot. Recipe dishes link to their detail
// page and carry their quantity (DEC-91); multiple dishes stack. Leftovers name
// what's actually being eaten — the eaten dish (linked) or the takeaway/other
// source. Markers and unplanned occasions are plain text.
function MealContent({ slot }: { slot: PlanSlot }): React.ReactElement {
  switch (slot.slotType) {
    case 'eat_out':
      return <span className="text-sm">Eat out</span>;
    case 'takeaway':
      return <span className="text-sm">Takeaway</span>;
    case 'leftovers': {
      const dish = slot.items[0];
      return (
        <span className="text-sm">
          <span className="text-muted-foreground">Leftovers · </span>
          {dish ? (
            <>
              <RecipeName item={dish} />
              <DishQty item={dish} />
            </>
          ) : (
            leftoversSummary(slot)
          )}
        </span>
      );
    }
    case 'recipe': {
      const items = eatItems(slot);
      if (items.length === 0) {
        return (
          <span className="text-sm text-muted-foreground">— not planned —</span>
        );
      }
      const [item] = items;
      if (items.length === 1 && item) {
        return (
          <span className="text-sm">
            <RecipeName item={item} />
            <DishQty item={item} />
          </span>
        );
      }
      return (
        <ul className="flex flex-col gap-0.5 text-right text-sm">
          {items.map((item) => (
            <li key={item.id}>
              <RecipeName item={item} />
              <DishQty item={item} />
            </li>
          ))}
        </ul>
      );
    }
    case 'empty':
    default:
      return (
        <span className="text-sm text-muted-foreground">— not planned —</span>
      );
  }
}

// One occasion row: the occasion name sits on the left; its meal summary, the
// "who's eating" chip, and any free-text comment stack right-justified opposite.
function MealRow({
  slot,
  memberNameById,
}: {
  slot: PlanSlot;
  memberNameById: ReadonlyMap<string, string>;
}): React.ReactElement {
  return (
    <li className="flex items-start justify-between gap-4 px-4 py-2">
      <span className="text-sm font-medium">{slot.occasionName}</span>
      <div className="flex min-w-0 flex-col items-end gap-1 text-right">
        <MealContent slot={slot} />
        <SlotDinersChip
          dinerNames={slot.dinerUserIds.map(
            (id) => memberNameById.get(id) ?? 'Unknown',
          )}
          guestCount={slot.guestCount}
        />
        <SlotCommentLine comment={slot.comment} />
      </div>
    </li>
  );
}

function QuickActions(): React.ReactElement {
  return (
    <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
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

  // Resolve a slot's diner ids to names for the "who's eating" chip.
  const members = trpc.user.listHouseholdMembers.useQuery();
  const memberNameById = new Map<string, string>(
    (members.data?.members ?? []).map((m) => [m.id, m.name]),
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
                  <MealRow
                    key={slot.id}
                    slot={slot}
                    memberNameById={memberNameById}
                  />
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
                          <MealRow
                            key={slot.id}
                            slot={slot}
                            memberNameById={memberNameById}
                          />
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

          {/* Primary navigation lives at the foot of the page. A 2-up grid on
              phones keeps the four buttons tidy; an auto-width row from `sm`. */}
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
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
