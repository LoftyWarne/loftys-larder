import { and, asc, eq } from 'drizzle-orm';

import type {
  HealthScoreLine,
  HealthScoreRecipeKind,
  HealthScoreRequest,
} from '../../../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../../config.ts';
import type { Db } from '../../db/index.ts';
import { ingredients } from '../../db/schema/ingredients.ts';
import {
  recipeIngredients,
  recipeMethod,
  recipes,
} from '../../db/schema/recipes.ts';
import {
  preparationTypes,
  unitsOfMeasurement,
} from '../../db/schema/reference.ts';
import type { Tx } from '../../db/withTransaction.ts';

// What a recipe's Health Score is based on (DEC-112). Built before the model
// call and again inside the write's transaction, by this one function, so the
// two can be compared: a recipe that changed during the call isn't written.
// Description, tags, times, cost, source, tips, safety notes, prep-ahead
// marks, image and plant points are never read here, so never sent.

type Reader = Db | Tx;

export interface ScoredRecipe {
  isDeleted: boolean;
  request: HealthScoreRequest;
}

// Null when the recipe isn't in the household.
export async function loadScoredRecipe(
  db: Reader,
  recipeId: number,
): Promise<ScoredRecipe | null> {
  const [header] = await db
    .select({
      name: recipes.name,
      baseServings: recipes.baseServings,
      isBase: recipes.isBase,
      baseRecipeId: recipes.baseRecipeId,
      isDeleted: recipes.isDeleted,
      caloriesPerServing: recipes.caloriesPerServing,
      fatPerServing: recipes.fatPerServing,
      saturatedFatPerServing: recipes.saturatedFatPerServing,
      carbsPerServing: recipes.carbsPerServing,
      sugarPerServing: recipes.sugarPerServing,
      fibrePerServing: recipes.fibrePerServing,
      proteinPerServing: recipes.proteinPerServing,
      saltPerServing: recipes.saltPerServing,
      nutritionIsEstimated: recipes.nutritionIsEstimated,
    })
    .from(recipes)
    .where(
      and(
        eq(recipes.id, recipeId),
        eq(recipes.householdId, CURRENT_HOUSEHOLD_ID),
      ),
    )
    .limit(1);
  if (!header) return null;

  const [lines, steps, base] = await Promise.all([
    loadLines(db, recipeId),
    loadSteps(db, recipeId),
    header.baseRecipeId === null ? null : loadBase(db, header.baseRecipeId),
  ]);
  const kind: HealthScoreRecipeKind = header.isBase
    ? 'base'
    : header.baseRecipeId === null
      ? 'standalone'
      : 'variation';
  return {
    isDeleted: header.isDeleted,
    request: {
      recipe: {
        name: header.name,
        kind,
        baseServings: header.baseServings,
        lines,
        steps,
        nutrition: {
          caloriesPerServing: header.caloriesPerServing,
          fatPerServing: header.fatPerServing,
          saturatedFatPerServing: header.saturatedFatPerServing,
          carbsPerServing: header.carbsPerServing,
          sugarPerServing: header.sugarPerServing,
          fibrePerServing: header.fibrePerServing,
          proteinPerServing: header.proteinPerServing,
          saltPerServing: header.saltPerServing,
        },
        nutritionIsEstimated: header.nutritionIsEstimated,
      },
      base,
    },
  };
}

// A variation's plate includes its base, so the base's lines count too.
export function scoredLineCount(request: HealthScoreRequest): number {
  return request.recipe.lines.length + (request.base?.lines.length ?? 0);
}

async function loadBase(
  db: Reader,
  baseRecipeId: number,
): Promise<HealthScoreRequest['base']> {
  const [header] = await db
    .select({ baseServings: recipes.baseServings })
    .from(recipes)
    .where(
      and(
        eq(recipes.id, baseRecipeId),
        eq(recipes.householdId, CURRENT_HOUSEHOLD_ID),
      ),
    )
    .limit(1);
  if (!header) return null;
  const [lines, steps] = await Promise.all([
    loadLines(db, baseRecipeId),
    loadSteps(db, baseRecipeId),
  ]);
  return { baseServings: header.baseServings, lines, steps };
}

// In the order the cook entered them. Quantities are numbers: the DB pads
// them to scale ("200.000").
async function loadLines(
  db: Reader,
  recipeId: number,
): Promise<HealthScoreLine[]> {
  const rows = await db
    .select({
      name: ingredients.name,
      quantity: recipeIngredients.quantity,
      unit: unitsOfMeasurement.name,
      prepType: preparationTypes.name,
      isOptional: recipeIngredients.isOptional,
    })
    .from(recipeIngredients)
    .innerJoin(ingredients, eq(ingredients.id, recipeIngredients.ingredientId))
    .innerJoin(
      unitsOfMeasurement,
      eq(unitsOfMeasurement.id, ingredients.defaultUnitId),
    )
    .leftJoin(
      preparationTypes,
      eq(preparationTypes.id, recipeIngredients.prepTypeId),
    )
    .where(eq(recipeIngredients.recipeId, recipeId))
    .orderBy(asc(recipeIngredients.id));
  return rows.map((row) => ({ ...row, quantity: Number(row.quantity) }));
}

async function loadSteps(db: Reader, recipeId: number): Promise<string[]> {
  const rows = await db
    .select({ instruction: recipeMethod.instruction })
    .from(recipeMethod)
    .where(eq(recipeMethod.recipeId, recipeId))
    .orderBy(asc(recipeMethod.stepNumber));
  return rows.map((row) => row.instruction);
}
