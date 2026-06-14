import { type SQL, and, eq, sql } from 'drizzle-orm';

import { CURRENT_HOUSEHOLD_ID } from '../config.ts';
import { recipes } from '../db/schema/recipes.ts';

// The single sanctioned encoding of "what recipes can I pick right now?"
// (cross-cutting concern #5). Every consumer that filters the recipes table
// for a picker or list view ANDs the result of this helper into its WHERE
// clause; when the visibility rules change (extra picker flag, new household
// scope), one site changes.
//
// Scopes by household; hides soft-deleted by default. `includePickerHidden`
// (so named because the call site asking for it is offering a *new* picker)
// hides batch-versions whose base recipe is soft-deleted — past plans keep
// rendering those rows via `recipes.get`, but the picker doesn't surface
// them. `isBase` filters to bases (or non-bases) for the base picker.

export interface PickableRecipesOptions {
  includeDeleted?: boolean;
  // When true, hide batch-versions whose base recipe is soft-deleted from
  // the result. Set on new pickers; left off for historical reads.
  includePickerHidden?: boolean;
  isBase?: boolean;
}

export function pickableRecipesWhere(
  options: PickableRecipesOptions = {},
): SQL {
  const conditions: SQL[] = [eq(recipes.householdId, CURRENT_HOUSEHOLD_ID)];

  if (!options.includeDeleted) {
    conditions.push(eq(recipes.isDeleted, false));
  }

  if (options.isBase !== undefined) {
    conditions.push(eq(recipes.isBase, options.isBase));
  }

  if (options.includePickerHidden) {
    // Hide batch-versions whose base is soft-deleted. The correlated subquery
    // reads the recipes table with the table name spelled out so it doesn't
    // collide with the outer reference; keeps the helper composable with any
    // outer FROM / JOIN shape the caller already has.
    conditions.push(
      sql`(${recipes.baseRecipeId} IS NULL OR NOT EXISTS (
        SELECT 1 FROM recipes AS base
        WHERE base.id = ${recipes.baseRecipeId}
          AND base.is_deleted = true
      ))`,
    );
  }

  const combined = and(...conditions);
  if (!combined) {
    throw new Error('pickableRecipesWhere produced no conditions');
  }
  return combined;
}
