import { and, asc, eq, gt, inArray, lt, sql } from 'drizzle-orm';

import type {
  MealPlanRecipe,
  MealPlanRequest,
  MealPlanSlotRequest,
  PlanProposal,
  PlanProposalSlot,
  ProposePlanInput,
  ProposeSlotInput,
} from '../../../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../../config.ts';
import type { Db } from '../../db/index.ts';
import { ingredients } from '../../db/schema/ingredients.ts';
import {
  mealPlanSlotItems,
  mealPlanSlots,
  mealPlans,
} from '../../db/schema/meal-plans.ts';
import { recipeHealthScores } from '../../db/schema/recipe-health.ts';
import { recipeRatings } from '../../db/schema/recipe-social.ts';
import {
  recipeIngredients,
  recipeTagLinks,
  recipeTags,
  recipes,
} from '../../db/schema/recipes.ts';
import { addDays, formatCivilDate } from '../date-utils.ts';
import { healthScoreDueReason } from '../health-score/due.ts';
import { pickableRecipesWhere } from '../pickable-recipes.ts';

// What the meal planner is told (DEC-117). Method text, comments, cost,
// images, nutrition, plant-point counts and who the diners are are never read
// here, so never sent.

export const RECENCY_WINDOW_DAYS = 28;

// Each pickable recipe in the household, with how recently and how often it
// was planned before `startDate`. A slot item counts as planned when it's
// eaten there; a serving variation's slots don't count for its base.
export async function loadPlannerLibrary(
  db: Db,
  options: { startDate: Date; healthScoreSince: string },
): Promise<MealPlanRecipe[]> {
  const rows = await db
    .select({
      id: recipes.id,
      name: recipes.name,
      isBase: recipes.isBase,
      baseRecipeId: recipes.baseRecipeId,
      baseServings: recipes.baseServings,
      activeMins: recipes.activeTimeMins,
      totalMins: recipes.totalTimeMins,
      score: recipeHealthScores.score,
      isStale: recipeHealthScores.isStale,
      scoredAt: recipeHealthScores.scoredAt,
    })
    .from(recipes)
    .leftJoin(recipeHealthScores, eq(recipeHealthScores.recipeId, recipes.id))
    .where(pickableRecipesWhere({ includePickerHidden: true }))
    .orderBy(asc(recipes.id));
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const [tagRows, ingredientRows, ratingRows, recencyRows] = await Promise.all([
    db
      .select({ recipeId: recipeTagLinks.recipeId, name: recipeTags.name })
      .from(recipeTagLinks)
      .innerJoin(recipeTags, eq(recipeTags.id, recipeTagLinks.tagId))
      .where(
        and(
          eq(recipeTags.householdId, CURRENT_HOUSEHOLD_ID),
          inArray(recipeTagLinks.recipeId, ids),
        ),
      )
      .orderBy(asc(recipeTags.name)),
    db
      .select({ recipeId: recipeIngredients.recipeId, name: ingredients.name })
      .from(recipeIngredients)
      .innerJoin(
        ingredients,
        eq(ingredients.id, recipeIngredients.ingredientId),
      )
      .where(
        and(
          eq(ingredients.householdId, CURRENT_HOUSEHOLD_ID),
          inArray(recipeIngredients.recipeId, ids),
        ),
      )
      .orderBy(asc(recipeIngredients.id)),
    db
      .select({
        recipeId: recipeRatings.recipeId,
        average: sql<string>`avg(${recipeRatings.rating})`,
      })
      .from(recipeRatings)
      .where(inArray(recipeRatings.recipeId, ids))
      .groupBy(recipeRatings.recipeId),
    loadRecency(db, options.startDate),
  ]);

  const tags = groupNames(tagRows);
  const ingredientNames = groupNames(ingredientRows);
  const ratings = new Map(
    ratingRows.map((row) => [
      row.recipeId,
      Math.round(Number(row.average) * 10) / 10,
    ]),
  );
  const recency = new Map(recencyRows.map((row) => [row.recipeId, row]));

  return rows.map((row) => {
    const stored =
      row.score === null || row.isStale === null || row.scoredAt === null
        ? null
        : { isStale: row.isStale, scoredAt: row.scoredAt };
    const planned = recency.get(row.id);
    return {
      id: row.id,
      name: row.name,
      tags: tags.get(row.id) ?? [],
      kind: row.isBase
        ? 'base'
        : row.baseRecipeId === null
          ? 'standalone'
          : 'variation',
      baseRecipeId: row.baseRecipeId,
      baseServings: row.baseServings,
      activeMins: row.activeMins,
      totalMins: row.totalMins,
      averageRating: ratings.get(row.id) ?? null,
      healthScore: row.score,
      healthScoreOutOfDate:
        stored !== null &&
        healthScoreDueReason(stored, options.healthScoreSince) !== null,
      ingredientNames: ingredientNames.get(row.id) ?? [],
      lastPlannedOn: planned?.lastPlannedOn ?? null,
      timesPlannedLast4Weeks: planned?.timesInWindow ?? 0,
    };
  });
}

interface RecencyRow {
  recipeId: number;
  // `YYYY-MM-DD`, as Postgres returns a date from raw SQL.
  lastPlannedOn: string;
  timesInWindow: number;
}

// One query over every plan in the household (DEC-17). Plans are deleted
// outright, so every plan that exists counts. Slots on or after the start
// don't count; a recipe eaten twice at one slot counts once.
async function loadRecency(db: Db, startDate: Date): Promise<RecencyRow[]> {
  const windowStart = addDays(startDate, -RECENCY_WINDOW_DAYS);
  return await db
    .select({
      recipeId: mealPlanSlotItems.recipeId,
      lastPlannedOn: sql<string>`max(${mealPlanSlots.date})`,
      timesInWindow:
        sql<number>`count(distinct ${mealPlanSlots.id}) filter (where ${mealPlanSlots.date} >= ${formatCivilDate(windowStart)})`.mapWith(
          Number,
        ),
    })
    .from(mealPlanSlotItems)
    .innerJoin(mealPlanSlots, eq(mealPlanSlots.id, mealPlanSlotItems.slotId))
    .innerJoin(mealPlans, eq(mealPlans.id, mealPlanSlots.planId))
    .where(
      and(
        eq(mealPlans.householdId, CURRENT_HOUSEHOLD_ID),
        lt(mealPlanSlots.date, startDate),
        gt(mealPlanSlotItems.eaten, 0),
      ),
    )
    .groupBy(mealPlanSlotItems.recipeId);
}

function groupNames(
  rows: { recipeId: number; name: string }[],
): Map<number, string[]> {
  const grouped = new Map<number, string[]>();
  for (const { recipeId, name } of rows) {
    const names = grouped.get(recipeId) ?? [];
    if (!names.includes(name)) names.push(name);
    grouped.set(recipeId, names);
  }
  return grouped;
}

export function slotHeadcount(slot: {
  dinerUserIds: string[];
  guestCount: number;
}): number {
  return new Set(slot.dinerUserIds).size + slot.guestCount;
}

// The planner's view of the input: occasion names for ids, headcounts for
// diners, and an empty Brief or note as none. A previous proposal's slots
// that aren't in this plan are dropped, so the client can't pad the request.
export function buildMealPlanRequest(
  input: ProposePlanInput,
  library: MealPlanRecipe[],
  occasionNames: ReadonlyMap<number, string>,
): MealPlanRequest {
  const occasion = (id: number) => occasionNames.get(id) ?? String(id);
  return {
    slots: input.slots.map((slot) => ({
      date: slot.date,
      occasion: occasion(slot.occasionId),
      headcount: slotHeadcount(slot),
      fixed: slot.fixed,
    })),
    basesToCook: basesToCook(input.slots, library, occasion),
    recipes: library,
    brief: input.brief === '' ? null : input.brief,
    note: input.note === '' ? null : input.note,
    previous:
      input.previous && toPrevious(input.previous, input.slots, occasion),
  };
}

// A fixed serving variation needs a base portion for every portion it cooks
// (DEC-91): a fixed recipe cooks the headcount, a Batch its portions.
function basesToCook(
  planSlots: ProposePlanInput['slots'],
  library: MealPlanRecipe[],
  occasion: (id: number) => string,
): MealPlanRequest['basesToCook'] {
  const byId = new Map(library.map((recipe) => [recipe.id, recipe]));
  return planSlots.flatMap((slot) => {
    const fixed = slot.fixed;
    if (fixed?.kind !== 'recipe' && fixed?.kind !== 'batch') return [];
    const baseRecipeId = byId.get(fixed.recipeId)?.baseRecipeId ?? null;
    const portions =
      fixed.kind === 'batch' ? fixed.portions : slotHeadcount(slot);
    if (baseRecipeId === null || portions === 0) return [];
    return [
      {
        baseRecipeId,
        portions,
        neededBy: { date: slot.date, occasion: occasion(slot.occasionId) },
      },
    ];
  });
}

// The planner's view of Suggest again for one slot: the plan's slots as for a
// whole plan, and the review as it stands. Entries in `current` that aren't
// in this plan, or are for a fixed slot, are dropped.
export function buildMealPlanSlotRequest(
  input: ProposeSlotInput,
  library: MealPlanRecipe[],
  occasionNames: ReadonlyMap<number, string>,
): MealPlanSlotRequest {
  const occasion = (id: number) => occasionNames.get(id) ?? String(id);
  const open = new Set(
    input.slots.filter((slot) => slot.fixed === null).map(planSlotKey),
  );
  return {
    slots: input.slots.map((slot) => ({
      date: slot.date,
      occasion: occasion(slot.occasionId),
      headcount: slotHeadcount(slot),
      fixed: slot.fixed,
    })),
    basesToCook: basesToCook(input.slots, library, occasion),
    recipes: library,
    brief: input.brief === '' ? null : input.brief,
    current: input.current
      .filter((slot) => open.has(planSlotKey(slot)))
      .map((slot) => toSlotDish(slot, occasion)),
    target: {
      date: input.target.date,
      occasion: occasion(input.target.occasionId),
    },
    avoidRecipeIds: [...new Set(input.avoidRecipeIds)],
  };
}

function planSlotKey(slot: { date: string; occasionId: number }): string {
  return `${slot.date}|${slot.occasionId.toString()}`;
}

function toPrevious(
  previous: PlanProposal,
  planSlots: ProposePlanInput['slots'],
  occasion: (id: number) => string,
): NonNullable<MealPlanRequest['previous']> {
  const inPlan = new Set(planSlots.map(planSlotKey));
  return {
    slots: previous.slots
      .filter((slot) => inPlan.has(planSlotKey(slot)))
      .map((slot) => toSlotDish(slot, occasion)),
    summary: previous.summary,
  };
}

function toSlotDish(
  slot: Pick<PlanProposalSlot, 'date' | 'occasionId' | 'slotType' | 'items'>,
  occasion: (id: number) => string,
): MealPlanSlotRequest['current'][number] {
  const item = slot.items[0];
  return {
    date: slot.date,
    occasion: occasion(slot.occasionId),
    dish: item
      ? {
          kind: slot.slotType === 'leftovers' ? 'leftovers' : 'cook',
          recipeId: item.recipeId,
          prepared: item.prepared,
        }
      : null,
  };
}
