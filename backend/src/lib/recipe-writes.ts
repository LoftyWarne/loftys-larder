import { TRPCError } from '@trpc/server';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';

import type {
  DomainErrorCode,
  StepPrepAhead,
} from '../../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../config.ts';
import type { Db } from '../db/index.ts';
import { ingredients } from '../db/schema/ingredients.ts';
import {
  recipeIngredients,
  recipeMethod,
  recipeMethodIngredients,
  recipeSources,
  recipeTagLinks,
  recipeTags,
  recipes,
} from '../db/schema/recipes.ts';
import type { Tx } from '../db/withTransaction.ts';

// Recipe write code shared by the editor's procedures and create-from-import
// (DEC-108), so the two ways of making a recipe can't drift. Callers own the
// transaction, the checks around it and `markHealthScoreStale`.

type Writer = Db | Tx;

export type RecipeInsertValues = Omit<
  typeof recipes.$inferInsert,
  'id' | 'householdId' | 'addedByUserId'
>;

export async function insertRecipe(
  db: Writer,
  values: RecipeInsertValues,
  userId: string,
): Promise<number> {
  const inserted = await db
    .insert(recipes)
    .values({
      ...values,
      householdId: CURRENT_HOUSEHOLD_ID,
      addedByUserId: userId,
    })
    .returning({ id: recipes.id });
  const row = inserted[0];
  if (!row) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Insert returned no row',
    });
  }
  return row.id;
}

export interface IngredientLineValues {
  ingredientId: number;
  quantity: string;
  prepTypeId: number | null;
  isOptional: boolean;
}

export async function writeIngredientLines(
  tx: Tx,
  recipeId: number,
  lines: readonly IngredientLineValues[],
): Promise<void> {
  await tx
    .delete(recipeIngredients)
    .where(eq(recipeIngredients.recipeId, recipeId));
  if (lines.length > 0) {
    await tx.insert(recipeIngredients).values(
      lines.map((line) => ({
        recipeId,
        ingredientId: line.ingredientId,
        quantity: line.quantity,
        prepTypeId: line.prepTypeId,
        isOptional: line.isOptional,
      })),
    );
  }
  // An ingredient removed from the recipe takes its step links with it
  // (DEC-99). Never blocked by step amounts: Save & Finish saves
  // ingredients before the method, so the method save is where an
  // over-total amount gets caught.
  const keptIngredientIds = lines.map((line) => line.ingredientId);
  await tx
    .delete(recipeMethodIngredients)
    .where(
      and(
        inArray(
          recipeMethodIngredients.methodStepId,
          tx
            .select({ id: recipeMethod.id })
            .from(recipeMethod)
            .where(eq(recipeMethod.recipeId, recipeId)),
        ),
        keptIngredientIds.length > 0
          ? notInArray(recipeMethodIngredients.ingredientId, keptIngredientIds)
          : undefined,
      ),
    );
}

export interface MethodStepValues {
  instruction: string;
  safetyNote: string | null;
  tip: string | null;
  prepAhead: StepPrepAhead | null;
  ingredients: readonly { ingredientId: number; quantity: string | null }[];
}

export async function writeMethod(
  tx: Tx,
  recipeId: number,
  steps: readonly MethodStepValues[],
): Promise<void> {
  await tx
    .delete(recipeMethodIngredients)
    .where(
      inArray(
        recipeMethodIngredients.methodStepId,
        tx
          .select({ id: recipeMethod.id })
          .from(recipeMethod)
          .where(eq(recipeMethod.recipeId, recipeId)),
      ),
    );
  await tx.delete(recipeMethod).where(eq(recipeMethod.recipeId, recipeId));
  if (steps.length === 0) return;

  // Numbering is authoritative server-side — the unique
  // `(recipe_id, step_number)` index would otherwise expose a footgun
  // if clients sent duplicate step numbers.
  const inserted = await tx
    .insert(recipeMethod)
    .values(
      steps.map((step, index) => ({
        recipeId,
        stepNumber: index + 1,
        instruction: step.instruction,
        safetyNote: step.safetyNote,
        tip: step.tip,
        prepAhead: step.prepAhead,
      })),
    )
    .returning({
      id: recipeMethod.id,
      stepNumber: recipeMethod.stepNumber,
    });
  const stepIdByNumber = new Map(
    inserted.map((row) => [row.stepNumber, row.id]),
  );
  const links = steps.flatMap((step, index) => {
    const methodStepId = stepIdByNumber.get(index + 1);
    if (methodStepId === undefined) return [];
    return step.ingredients.map((link) => ({
      methodStepId,
      ingredientId: link.ingredientId,
      quantity: link.quantity,
    }));
  });
  if (links.length > 0) {
    await tx.insert(recipeMethodIngredients).values(links);
  }
}

// Full replace by name (DEC-97). Unknown names are inserted into the
// household vocabulary; `ON CONFLICT DO NOTHING` against the
// `lower(name)` unique index means an existing spelling is kept and reused.
export async function writeTags(
  tx: Tx,
  recipeId: number,
  tagNames: readonly string[],
): Promise<void> {
  const byLowerName = new Map<string, string>();
  for (const name of tagNames) {
    const key = name.toLowerCase();
    if (!byLowerName.has(key)) byLowerName.set(key, name);
  }
  const names = Array.from(byLowerName.values());

  await tx.delete(recipeTagLinks).where(eq(recipeTagLinks.recipeId, recipeId));
  if (names.length === 0) return;

  await tx
    .insert(recipeTags)
    .values(names.map((name) => ({ householdId: CURRENT_HOUSEHOLD_ID, name })))
    .onConflictDoNothing();
  const tagRows = await tx
    .select({ id: recipeTags.id })
    .from(recipeTags)
    .where(
      and(
        eq(recipeTags.householdId, CURRENT_HOUSEHOLD_ID),
        inArray(sql`lower(${recipeTags.name})`, [...byLowerName.keys()]),
      ),
    );
  await tx
    .insert(recipeTagLinks)
    .values(tagRows.map((row) => ({ recipeId, tagId: row.id })));
}

// Every line's ingredient must belong to the household and be entered in its
// one unit (DEC-17, DEC-18). Checked before a transaction opens: the error
// can name the offending ingredient.
export async function assertIngredientLinesValid(
  db: Writer,
  lines: readonly { ingredientId: number; unitId: number }[],
): Promise<void> {
  if (lines.length === 0) return;
  const ingredientIds = Array.from(
    new Set(lines.map((line) => line.ingredientId)),
  );
  const ingredientRows = await db
    .select({ id: ingredients.id, defaultUnitId: ingredients.defaultUnitId })
    .from(ingredients)
    .where(
      and(
        inArray(ingredients.id, ingredientIds),
        eq(ingredients.householdId, CURRENT_HOUSEHOLD_ID),
      ),
    );
  const byId = new Map(ingredientRows.map((r) => [r.id, r]));

  for (const line of lines) {
    const ingredient = byId.get(line.ingredientId);
    if (!ingredient) {
      throw domainBadRequest(
        'RECIPE_INGREDIENT_NOT_FOUND',
        'One or more ingredients are not available to this household',
        { ingredientId: line.ingredientId },
      );
    }
    if (ingredient.defaultUnitId !== line.unitId) {
      throw domainBadRequest(
        'RECIPE_INGREDIENT_UNIT_MISMATCH',
        'Ingredient unit does not match its enforced unit',
        {
          ingredientId: line.ingredientId,
          expectedUnitId: ingredient.defaultUnitId,
          providedUnitId: line.unitId,
        },
      );
    }
  }
}

export async function assertSourceInHousehold(
  db: Writer,
  sourceId: number,
): Promise<void> {
  const rows = await db
    .select({ id: recipeSources.id })
    .from(recipeSources)
    .where(
      and(
        eq(recipeSources.id, sourceId),
        eq(recipeSources.householdId, CURRENT_HOUSEHOLD_ID),
      ),
    )
    .limit(1);
  if (rows.length === 0) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Source not found' });
  }
}

export async function assertIngredientsInHousehold(
  db: Writer,
  ingredientIds: readonly number[],
): Promise<void> {
  const unique = Array.from(new Set(ingredientIds));
  if (unique.length === 0) return;
  const known = await db
    .select({ id: ingredients.id })
    .from(ingredients)
    .where(
      and(
        inArray(ingredients.id, unique),
        eq(ingredients.householdId, CURRENT_HOUSEHOLD_ID),
      ),
    );
  const knownIds = new Set(known.map((row) => row.id));
  const unknownId = unique.find((id) => !knownIds.has(id));
  if (unknownId !== undefined) {
    throw domainBadRequest(
      'RECIPE_INGREDIENT_NOT_FOUND',
      'One or more ingredients are not available to this household',
      { ingredientId: unknownId },
    );
  }
}

// An ingredient's stated step amounts can't add up to more than its total
// across the recipe's lines (DEC-99). An ingredient with no line has no
// total to check against. Quantities compare as integer thousandths, so
// float error can't tip a sum over its total.
export function findStepAmountOverTotal<K>(
  links: readonly { key: K; quantity: string | null }[],
  totalsMilli: ReadonlyMap<K, number>,
): { key: K; stated: number; total: number } | null {
  const statedMilli = new Map<K, number>();
  for (const link of links) {
    if (link.quantity === null) continue;
    statedMilli.set(
      link.key,
      (statedMilli.get(link.key) ?? 0) + toMilli(link.quantity),
    );
  }
  for (const [key, stated] of statedMilli) {
    const total = totalsMilli.get(key);
    if (total !== undefined && stated > total) {
      return { key, stated: stated / 1000, total: total / 1000 };
    }
  }
  return null;
}

// `numeric(10,3)` values as integer thousandths.
export function toMilli(quantity: string): number {
  return Math.round(Number(quantity) * 1000);
}

function domainBadRequest(
  code: DomainErrorCode,
  message: string,
  metadata: Record<string, unknown> = {},
): TRPCError {
  return new TRPCError({
    code: 'BAD_REQUEST',
    message,
    cause: { code, ...metadata },
  });
}
