import { TRPCError } from '@trpc/server';
import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  dismissStorageGlanceInputSchema,
  getShoppingListForPlanInputSchema,
  getShoppingListForPlanResultSchema,
  setLineReservationsInputSchema,
  setLineReservationsResultSchema,
  toggleShoppingItemCheckedInputSchema,
  toggleShoppingItemCheckedResultSchema,
  type GetShoppingListForPlanResult,
  type SetLineReservationsResult,
  type ShoppingListCategory,
  type ShoppingListLine,
  type ShoppingStapleLine,
  type StapleState,
  type ToggleShoppingItemCheckedResult,
} from '../../../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../../config.ts';
import { ingredients } from '../../db/schema/ingredients.ts';
import {
  mealPlans,
  mealPlanSlotItems,
  mealPlanSlots,
} from '../../db/schema/meal-plans.ts';
import {
  ingredientCategories,
  unitsOfMeasurement,
} from '../../db/schema/reference.ts';
import { recipeIngredients, recipes } from '../../db/schema/recipes.ts';
import { shoppingListItems } from '../../db/schema/shopping-list.ts';
import { makeWithTransaction, type Tx } from '../../db/withTransaction.ts';
import { formatCivilDate, todayInLondon } from '../../lib/date-utils.ts';
import {
  aggregateContributions,
  formatFixed3FromMilli,
  parseMilliFromFixed3,
  type AggregatedShoppingListCategory,
  type AggregatedShoppingListLine,
  type ShoppingContribution,
} from '../../lib/shopping-aggregation.ts';
import {
  availableToLine,
  sortInDrawOrder,
  type HeldItem,
} from '../../lib/shopping-holdings.ts';
import {
  lineReservedMilli,
  loadLineHoldings,
  reconcileLineReservations,
  replaceLineReservations,
  type LineNeed,
} from '../../lib/shopping-storage.ts';
import {
  applyStapleTick,
  loadStaples,
  lockStapleState,
  needsRestock,
  type Staple,
} from '../../lib/staples.ts';
import { settleReservations } from '../../lib/stock-settlement.ts';
import { protectedProcedure, router } from '../init.ts';

export const shoppingRouter = router({
  getForPlan: protectedProcedure
    .input(getShoppingListForPlanInputSchema)
    .output(getShoppingListForPlanResultSchema)
    .query(async ({ ctx, input }): Promise<GetShoppingListForPlanResult> => {
      const today = todayInLondon();
      const withTransaction = makeWithTransaction(ctx.db);
      // The aggregation read also writes — settling (cross-cutting #23),
      // releasing line Reservations the plan no longer needs, lazy-create
      // (DEC-30) and the quantity-bound check-state reset (DEC-31). One
      // transaction keeps concurrent first-reads from racing on the
      // `shopping_list_items` insert (cross-cutting concern #13).
      return await withTransaction(async (tx) => {
        await settleReservations(tx, today);
        const planRow = await loadHouseholdPlan(tx, input.planId);

        const contribs = await selectPreparedContributions(tx, planRow.id);

        // A pure sum per ingredient (DEC-18). Storage and Staples are a
        // second step, never folded into it.
        const aggregated = aggregateContributions(contribs, {
          planStart: planRow.startDate,
        });

        const staples = await loadStaples(tx);
        const { toBuy, staplesNeeded } = splitOffStaples(aggregated, staples);

        const needs = new Map<number, LineNeed>();
        for (const cat of toBuy) {
          for (const line of cat.lines) {
            needs.set(line.ingredient.id, lineNeed(line));
          }
        }
        await reconcileLineReservations(tx, planRow.id, needs);
        const holdings = await loadLineHoldings(tx, planRow.id, [
          ...needs.keys(),
        ]);
        const withStorage = decorateWithStorage(toBuy, holdings);

        const lineTotals = new Map<number, string>();
        for (const cat of withStorage) {
          for (const line of cat.lines) {
            lineTotals.set(line.ingredient.id, line.leftToBuy);
          }
        }
        for (const line of staplesNeeded.values()) {
          lineTotals.set(line.ingredient.id, line.totalQuantity);
        }
        const checkRows = await reconcileCheckState(tx, planRow.id, lineTotals);

        const isCurrent = planRow.endDate >= today;
        return {
          planId: planRow.id,
          categories: decorateWithCheckState(withStorage, checkRows),
          ...groupStaples(staples, staplesNeeded, checkRows, isCurrent),
          showStorageGlance: planRow.storageGlanceDismissedAt === null,
        };
      });
    }),

  toggleChecked: protectedProcedure
    .input(toggleShoppingItemCheckedInputSchema)
    .output(toggleShoppingItemCheckedResultSchema)
    .mutation(
      async ({ ctx, input }): Promise<ToggleShoppingItemCheckedResult> => {
        const today = todayInLondon();
        const withTransaction = makeWithTransaction(ctx.db);
        return await withTransaction(async (tx) => {
          await settleReservations(tx, today);
          const planRow = await loadHouseholdPlan(tx, input.planId);
          const stapleState = await lockStapleState(tx, input.ingredientId);

          // Re-run the contribution SQL scoped to one ingredient so the
          // total we stamp is the server's authoritative current total
          // (DEC-31). A client-supplied quantity would let stale snapshots
          // poison the reset invariant. Zero rows here means the ingredient
          // no longer participates in the plan — refuse rather than plant
          // an orphan `shopping_list_items` row. A Staple can be on the list
          // without the plan needing it, to restock.
          const contributions = await selectIngredientContributions(
            tx,
            planRow.id,
            input.ingredientId,
          );
          if (contributions.length === 0 && stapleState === null) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Ingredient does not contribute to this plan',
              cause: { code: 'SHOPPING_INGREDIENT_NOT_IN_PLAN' },
            });
          }

          // An ordinary line's tick records what's left to buy, so reserving
          // more from storage afterwards resets it. A Staple has no Stock
          // items, so its tick records the plan's amount, or nothing when
          // it's listed only to restock.
          let lastCheckedQuantity: string | null = null;
          if (input.isChecked && contributions.length > 0) {
            const total = parseMilliFromFixed3(
              computeIngredientTotal(contributions, planRow.startDate),
            );
            const reserved =
              stapleState === null
                ? await lineReservedMilli(tx, planRow.id, input.ingredientId)
                : 0n;
            const left = total > reserved ? total - reserved : 0n;
            lastCheckedQuantity = formatFixed3FromMilli(left);
          }

          const [existing] = await tx
            .select({
              replacedStapleState: shoppingListItems.replacedStapleState,
            })
            .from(shoppingListItems)
            .where(
              and(
                eq(shoppingListItems.planId, planRow.id),
                eq(shoppingListItems.ingredientId, input.ingredientId),
              ),
            )
            .for('update');

          // Ticks move no stock. A Staple's restock is the one exception.
          const replacedStapleState =
            stapleState === null
              ? null
              : await applyStapleTick(
                  tx,
                  input.ingredientId,
                  stapleState,
                  input.isChecked,
                  existing?.replacedStapleState ?? null,
                );

          await tx
            .insert(shoppingListItems)
            .values({
              planId: planRow.id,
              ingredientId: input.ingredientId,
              isChecked: input.isChecked,
              lastCheckedQuantity,
              replacedStapleState,
            })
            .onConflictDoUpdate({
              target: [
                shoppingListItems.planId,
                shoppingListItems.ingredientId,
              ],
              set: {
                isChecked: input.isChecked,
                lastCheckedQuantity,
                replacedStapleState,
              },
            });

          return {
            planId: planRow.id,
            ingredientId: input.ingredientId,
            isChecked: input.isChecked,
          };
        });
      },
    ),

  setLineReservations: protectedProcedure
    .input(setLineReservationsInputSchema)
    .output(setLineReservationsResultSchema)
    .mutation(async ({ ctx, input }): Promise<SetLineReservationsResult> => {
      const today = todayInLondon();
      const withTransaction = makeWithTransaction(ctx.db);
      return await withTransaction(async (tx) => {
        await settleReservations(tx, today);
        const planRow = await loadHouseholdPlan(tx, input.planId);
        const contributions = await selectIngredientContributions(
          tx,
          planRow.id,
          input.ingredientId,
        );
        if (contributions.length === 0) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Ingredient does not contribute to this plan',
            cause: { code: 'SHOPPING_INGREDIENT_NOT_IN_PLAN' },
          });
        }
        const aggregated = aggregateContributions(contributions, {
          planStart: planRow.startDate,
        });
        const line = aggregated[0]?.lines[0];
        if (!line) {
          throw new Error(
            'shopping.setLineReservations: no line for a non-empty contribution set',
          );
        }
        const reserved = await replaceLineReservations(
          tx,
          planRow.id,
          input.ingredientId,
          lineNeed(line),
          input.choice,
        );
        return {
          planId: planRow.id,
          ingredientId: input.ingredientId,
          reserved: formatFixed3FromMilli(reserved),
        };
      });
    }),

  dismissStorageGlance: protectedProcedure
    .input(dismissStorageGlanceInputSchema)
    .output(dismissStorageGlanceInputSchema)
    .mutation(async ({ ctx, input }) => {
      const updated = await ctx.db
        .update(mealPlans)
        .set({ storageGlanceDismissedAt: sql`now()` })
        .where(
          and(
            eq(mealPlans.id, input.planId),
            eq(mealPlans.householdId, CURRENT_HOUSEHOLD_ID),
          ),
        )
        .returning({ id: mealPlans.id });
      const row = updated[0];
      if (!row) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Plan not found' });
      }
      return { planId: row.id };
    }),
});

interface PlanRow {
  id: number;
  startDate: Date;
  endDate: Date;
  storageGlanceDismissedAt: Date | null;
}

async function loadHouseholdPlan(tx: Tx, id: number): Promise<PlanRow> {
  const rows = await tx
    .select({
      id: mealPlans.id,
      startDate: mealPlans.startDate,
      endDate: mealPlans.endDate,
      storageGlanceDismissedAt: mealPlans.storageGlanceDismissedAt,
    })
    .from(mealPlans)
    .where(
      and(
        eq(mealPlans.id, id),
        eq(mealPlans.householdId, CURRENT_HOUSEHOLD_ID),
      ),
    )
    .limit(1)
    // Every shopping write needs the plan to stay, and its foreign keys would
    // take this lock anyway. Taking it first, before any Stock item or
    // Reservation, matches `plans.delete`, which locks the plan and then
    // cascades to its Reservations.
    .for('key share');
  const row = rows[0];
  if (!row) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Plan not found' });
  }
  return row;
}

// Contribution rows for the buy list (DEC-91): one row per (prepared item,
// recipe_ingredients line), scaled by the item's `prepared` (portions cooked —
// you buy for what you cook, not what you eat). Filtered to `prepared > 0`, so a
// leftovers / eat-out / takeaway consumption row (`prepared = 0`) contributes
// nothing without any slot-type guard. Each recipe contributes only its own
// ingredient rows — a serving variation's base flows in via the base dish's own
// prepared row, so no double-count. Recipes are joined without an `is_deleted`
// filter — historical plans still aggregate (DEC-21/22).
async function selectPreparedContributions(
  tx: Tx,
  planId: number,
): Promise<ShoppingContribution[]> {
  const rows = await itemContributionQuery(tx).where(
    and(
      sql`${mealPlanSlotItems.prepared} > 0`,
      eq(mealPlans.id, planId),
      eq(mealPlans.householdId, CURRENT_HOUSEHOLD_ID),
    ),
  );
  return rows.map(toContribution);
}

// The prepared contributions scoped to one ingredient. Used by `toggleChecked`
// to (a) prove the ingredient contributes and (b) compute the authoritative
// total.
async function selectIngredientContributions(
  tx: Tx,
  planId: number,
  ingredientId: number,
): Promise<ShoppingContribution[]> {
  const rows = await itemContributionQuery(tx).where(
    and(
      sql`${mealPlanSlotItems.prepared} > 0`,
      eq(mealPlans.id, planId),
      eq(mealPlans.householdId, CURRENT_HOUSEHOLD_ID),
      eq(ingredients.id, ingredientId),
    ),
  );
  return rows.map(toContribution);
}

// Shared join skeleton: slot items → recipe → ingredient lines, scaled by the
// item's `prepared`. The caller appends the full `WHERE` — drizzle `.where()`
// replaces rather than ANDs, so every predicate lives there.
function itemContributionQuery(tx: Tx) {
  return tx
    .select(contributionProjection)
    .from(mealPlanSlotItems)
    .innerJoin(mealPlanSlots, eq(mealPlanSlots.id, mealPlanSlotItems.slotId))
    .innerJoin(mealPlans, eq(mealPlans.id, mealPlanSlots.planId))
    .innerJoin(recipes, eq(recipes.id, mealPlanSlotItems.recipeId))
    .innerJoin(recipeIngredients, eq(recipeIngredients.recipeId, recipes.id))
    .innerJoin(ingredients, eq(ingredients.id, recipeIngredients.ingredientId))
    .innerJoin(
      ingredientCategories,
      eq(ingredientCategories.id, ingredients.categoryId),
    )
    .innerJoin(
      unitsOfMeasurement,
      eq(unitsOfMeasurement.id, ingredients.defaultUnitId),
    )
    .$dynamic();
}

const contributionProjection = {
  slotId: mealPlanSlots.id,
  slotDate: mealPlanSlots.date,
  recipeId: recipes.id,
  recipeName: recipes.name,
  ingredientId: ingredients.id,
  ingredientName: ingredients.name,
  categoryId: ingredientCategories.id,
  categoryName: ingredientCategories.name,
  unitId: unitsOfMeasurement.id,
  unitName: unitsOfMeasurement.name,
  averageShelfLifeDays: ingredients.averageShelfLifeDays,
  isOptional: recipeIngredients.isOptional,
  // numeric arithmetic preserves precision; round to the column's
  // numeric(10,3) scale so the helper's integer-milli math is exact.
  scaledQuantity: sql<string>`round(${recipeIngredients.quantity} * ${mealPlanSlotItems.prepared}::numeric / ${recipes.baseServings}::numeric, 3)`,
} as const;

interface ContributionRow {
  slotId: number;
  slotDate: Date;
  recipeId: number;
  recipeName: string;
  ingredientId: number;
  ingredientName: string;
  categoryId: number;
  categoryName: string;
  unitId: number;
  unitName: string;
  averageShelfLifeDays: number | null;
  isOptional: boolean;
  scaledQuantity: string;
}

function toContribution(row: ContributionRow): ShoppingContribution {
  return {
    slotId: row.slotId,
    slotDate: formatCivilDate(row.slotDate),
    recipeId: row.recipeId,
    recipeName: row.recipeName,
    ingredientId: row.ingredientId,
    ingredientName: row.ingredientName,
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    unitId: row.unitId,
    unitName: row.unitName,
    averageShelfLifeDays: row.averageShelfLifeDays,
    isOptional: row.isOptional,
    scaledQuantity: row.scaledQuantity,
  };
}

// Single ingredient's contribution sum, expressed as a numeric(10,3) string
// for storage in `last_checked_quantity`. The aggregation helper already
// performs the milli arithmetic — reusing it here keeps the parsing /
// formatting rules in one place.
function computeIngredientTotal(
  contributions: ShoppingContribution[],
  planStart: Date,
): string {
  const aggregated = aggregateContributions(contributions, { planStart });
  const total = aggregated[0]?.lines[0]?.totalQuantity;
  if (!total) {
    throw new Error(
      'shopping.toggleChecked: aggregation produced no line for a non-empty contribution set',
    );
  }
  return total;
}

// Lazy-create + quantity-bound reset (DEC-30, DEC-31). Returns every check
// row for the plan, post-write, keyed by ingredient. A reset also forgets the
// Staple state a tick replaced, so it never changes a Staple's state.
//
// Strategy (bulk SELECT-then-upsert):
//   1. Read every existing row for the plan in one query.
//   2. In memory, partition into: missing rows → insert (false / NULL);
//      checked-with-stale-total → reset (false / NULL); unchanged → no-op.
//   3. Bulk-insert the missing set with `ON CONFLICT DO NOTHING` (concurrent
//      first-reads).
//   4. Bulk-update the reset set with one statement scoped by ingredient_id.
//
// Only ingredients in `ingredientTotals` are reconciled. A Staple listed only
// to restock has no total, so its tick is never reset.
//
// Numeric equality is exact via integer-milli (`'1.5'` vs `'1.500'` compare
// equal); naive string compare would over-fire the reset.
interface CheckRow {
  isChecked: boolean;
  replacedStapleState: StapleState | null;
}

async function reconcileCheckState(
  tx: Tx,
  planId: number,
  ingredientTotals: Map<number, string>,
): Promise<Map<number, CheckRow>> {
  const existing = await tx
    .select({
      ingredientId: shoppingListItems.ingredientId,
      isChecked: shoppingListItems.isChecked,
      lastCheckedQuantity: shoppingListItems.lastCheckedQuantity,
      replacedStapleState: shoppingListItems.replacedStapleState,
    })
    .from(shoppingListItems)
    .where(eq(shoppingListItems.planId, planId));

  const postWrite = new Map<number, CheckRow>(
    existing.map((row) => [
      row.ingredientId,
      {
        isChecked: row.isChecked,
        replacedStapleState: row.replacedStapleState,
      },
    ]),
  );
  const existingByIngredient = new Map(
    existing.map((row) => [row.ingredientId, row]),
  );

  const toInsert: { ingredientId: number }[] = [];
  const toReset: number[] = [];
  const cleared: CheckRow = { isChecked: false, replacedStapleState: null };

  for (const [ingredientId, currentTotal] of ingredientTotals) {
    const row = existingByIngredient.get(ingredientId);
    if (!row) {
      toInsert.push({ ingredientId });
      postWrite.set(ingredientId, cleared);
      continue;
    }
    if (row.isChecked) {
      const stale =
        row.lastCheckedQuantity === null ||
        parseMilliFromFixed3(row.lastCheckedQuantity) !==
          parseMilliFromFixed3(currentTotal);
      if (stale) {
        toReset.push(ingredientId);
        postWrite.set(ingredientId, cleared);
      }
    }
  }

  if (toInsert.length > 0) {
    await tx
      .insert(shoppingListItems)
      .values(
        toInsert.map((entry) => ({
          planId,
          ingredientId: entry.ingredientId,
          isChecked: false,
          lastCheckedQuantity: null,
        })),
      )
      .onConflictDoNothing({
        target: [shoppingListItems.planId, shoppingListItems.ingredientId],
      });
  }

  if (toReset.length > 0) {
    await tx
      .update(shoppingListItems)
      .set({
        isChecked: false,
        lastCheckedQuantity: null,
        replacedStapleState: null,
      })
      .where(
        and(
          eq(shoppingListItems.planId, planId),
          inArray(shoppingListItems.ingredientId, toReset),
        ),
      );
  }

  return postWrite;
}

type StorageLine = Omit<ShoppingListLine, 'isChecked'>;

interface StorageCategory {
  category: ShoppingListCategory['category'];
  lines: StorageLine[];
}

function decorateWithCheckState(
  categories: StorageCategory[],
  checkRows: Map<number, CheckRow>,
): ShoppingListCategory[] {
  return categories.map((cat) => ({
    category: cat.category,
    lines: cat.lines.map((line) => ({
      ...line,
      isChecked: checkRows.get(line.ingredient.id)?.isChecked ?? false,
    })),
  }));
}

// Takes Staples out of the lines to buy. They're listed in their own groups.
function splitOffStaples(
  categories: AggregatedShoppingListCategory[],
  staples: Map<number, Staple>,
): {
  toBuy: AggregatedShoppingListCategory[];
  staplesNeeded: Map<number, AggregatedShoppingListLine>;
} {
  const staplesNeeded = new Map<number, AggregatedShoppingListLine>();
  const toBuy: AggregatedShoppingListCategory[] = [];
  for (const cat of categories) {
    const lines: AggregatedShoppingListLine[] = [];
    for (const line of cat.lines) {
      if (staples.has(line.ingredient.id)) {
        staplesNeeded.set(line.ingredient.id, line);
      } else {
        lines.push(line);
      }
    }
    if (lines.length > 0) toBuy.push({ category: cat.category, lines });
  }
  return { toBuy, staplesNeeded };
}

function lineNeed(line: AggregatedShoppingListLine): LineNeed {
  const first = line.contributingSlots[0];
  if (!first) {
    throw new Error('shopping: a line with no contributing slot');
  }
  return {
    neededMilli: parseMilliFromFixed3(line.totalQuantity),
    neededOn: first.date,
  };
}

// The second step after the sum (DEC-118): what each line holds, has
// reserved and still has to buy. A line fully covered from storage drops its
// shelf-life warning, which is about food still to buy (DEC-37).
function decorateWithStorage(
  categories: AggregatedShoppingListCategory[],
  holdings: Map<number, HeldItem[]>,
): StorageCategory[] {
  return categories.map((cat) => ({
    category: cat.category,
    lines: cat.lines.map((line): StorageLine => {
      const held = sortInDrawOrder(holdings.get(line.ingredient.id) ?? []);
      const stockItems = held
        .filter(
          (item) => availableToLine(item) > 0n || item.reservedByLineMilli > 0n,
        )
        .map((item) => ({
          stockItemId: item.stockItemId,
          location: item.location,
          available: formatFixed3FromMilli(availableToLine(item)),
          reservedByLine: formatFixed3FromMilli(item.reservedByLineMilli),
          addedOn: item.addedOn,
          useBy: item.useBy,
        }));
      const reserved = held.reduce(
        (sum, item) => sum + item.reservedByLineMilli,
        0n,
      );
      const total = parseMilliFromFixed3(line.totalQuantity);
      const left = total > reserved ? total - reserved : 0n;
      const fromStorage = reserved > 0n && left === 0n;
      const { shelfLifeWarning, ...rest } = line;
      return {
        ...rest,
        ...(shelfLifeWarning && !fromStorage && { shelfLifeWarning }),
        reserved: formatFixed3FromMilli(reserved),
        leftToBuy: formatFixed3FromMilli(left),
        fromStorage,
        stockItems,
      };
    }),
  }));
}

// The Staples groups (DEC-118). Running-low and out Staples, and any ticked
// on this plan, go to restock: those the plan needs always, the rest only
// while the plan hasn't ended. In-stock Staples the plan needs go to "you
// have".
function groupStaples(
  staples: Map<number, Staple>,
  staplesNeeded: Map<number, AggregatedShoppingListLine>,
  checkRows: Map<number, CheckRow>,
  isCurrent: boolean,
): {
  staplesToRestock: ShoppingStapleLine[];
  staplesYouHave: ShoppingStapleLine[];
} {
  const staplesToRestock: ShoppingStapleLine[] = [];
  const staplesYouHave: ShoppingStapleLine[] = [];
  const sorted = [...staples.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
  for (const staple of sorted) {
    const needed = staplesNeeded.get(staple.ingredientId);
    const row = checkRows.get(staple.ingredientId);
    const isChecked = row?.isChecked ?? false;
    const tickedHere = isChecked && row?.replacedStapleState != null;
    const line: ShoppingStapleLine = {
      ingredient: { id: staple.ingredientId, name: staple.name },
      unit: { id: staple.unitId, name: staple.unitName },
      location: staple.location,
      state: staple.state,
      neededQuantity: needed?.totalQuantity ?? null,
      contributingSlots: needed?.contributingSlots ?? [],
      isChecked,
    };
    if (needsRestock(staple.state) || tickedHere) {
      if (needed || isCurrent) staplesToRestock.push(line);
    } else if (needed) {
      staplesYouHave.push(line);
    }
  }
  return { staplesToRestock, staplesYouHave };
}
