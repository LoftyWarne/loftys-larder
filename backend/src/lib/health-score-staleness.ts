import { and, asc, eq, inArray, or } from 'drizzle-orm';

import type {
  ReplaceRecipeIngredientsLine,
  ReplaceRecipeMethodStepInput,
  UpdateRecipeHeaderInput,
} from '../../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../config.ts';
import { recipeHealthScores } from '../db/schema/recipe-health.ts';
import {
  recipeIngredients,
  recipeMethod,
  recipes,
} from '../db/schema/recipes.ts';
import type { Tx } from '../db/withTransaction.ts';

// A stored health score goes out of date when a recipe edit changes what it
// was scored on (DEC-101). The write paths compare before they write, because
// Save & Finish re-sends ingredients and method even when nothing changed.

// Header fields a score depends on. Name, description, image, times, cost and
// source don't change what's eaten.
const HEALTH_SCORE_HEADER_FIELDS = [
  'baseServings',
  'caloriesPerServing',
  'proteinPerServing',
  'carbsPerServing',
  'fatPerServing',
  'saturatedFatPerServing',
  'fibrePerServing',
  'sugarPerServing',
  'saltPerServing',
] as const satisfies readonly (keyof UpdateRecipeHeaderInput['patch'])[];

export function headerPatchAffectsHealthScore(
  patch: UpdateRecipeHeaderInput['patch'],
): boolean {
  return HEALTH_SCORE_HEADER_FIELDS.some((key) => patch[key] !== undefined);
}

export async function ingredientLinesChanged(
  tx: Tx,
  recipeId: number,
  lines: readonly ReplaceRecipeIngredientsLine[],
): Promise<boolean> {
  const current = await tx
    .select({
      ingredientId: recipeIngredients.ingredientId,
      quantity: recipeIngredients.quantity,
      prepTypeId: recipeIngredients.prepTypeId,
      isOptional: recipeIngredients.isOptional,
    })
    .from(recipeIngredients)
    .where(eq(recipeIngredients.recipeId, recipeId));
  const before = current.map(ingredientLineKey).sort();
  const after = lines.map(ingredientLineKey).sort();
  return (
    before.length !== after.length ||
    before.some((key, index) => key !== after[index])
  );
}

// Quantities compare as numbers: the DB pads to scale ("200.000").
function ingredientLineKey(line: {
  ingredientId: number;
  quantity: string;
  prepTypeId: number | null;
  isOptional: boolean;
}): string {
  return JSON.stringify([
    line.ingredientId,
    Number(line.quantity),
    line.prepTypeId,
    line.isOptional,
  ]);
}

// Only the step text counts. Tips, safety notes, prep-ahead marks and
// per-step amounts don't change what's cooked or eaten.
export async function methodInstructionsChanged(
  tx: Tx,
  recipeId: number,
  steps: readonly ReplaceRecipeMethodStepInput[],
): Promise<boolean> {
  const current = await tx
    .select({ instruction: recipeMethod.instruction })
    .from(recipeMethod)
    .where(eq(recipeMethod.recipeId, recipeId))
    .orderBy(asc(recipeMethod.stepNumber));
  return (
    current.length !== steps.length ||
    current.some((row, index) => row.instruction !== steps[index]?.instruction)
  );
}

// Also marks the recipe's serving variations, which are scored together with
// their base's ingredients and method.
export async function markHealthScoreStale(
  tx: Tx,
  recipeId: number,
): Promise<void> {
  await tx
    .update(recipeHealthScores)
    .set({ isStale: true })
    .where(
      inArray(
        recipeHealthScores.recipeId,
        tx
          .select({ id: recipes.id })
          .from(recipes)
          .where(
            and(
              eq(recipes.householdId, CURRENT_HOUSEHOLD_ID),
              or(eq(recipes.id, recipeId), eq(recipes.baseRecipeId, recipeId)),
            ),
          ),
      ),
    );
}
