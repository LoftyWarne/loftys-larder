import { type SQL, and, eq } from 'drizzle-orm';

import { CURRENT_HOUSEHOLD_ID } from '../config.ts';
import { recipes } from '../db/schema/recipes.ts';

// The single sanctioned encoding of "what recipes can I pick right now?"
// (cross-cutting concern #5). Every consumer that filters the recipes table
// for a picker or list view ANDs the result of this helper into its WHERE
// clause; when the visibility rules change (extra picker flag, new household
// scope), one site changes.
//
// Today (FEAT-19): scopes by household and hides soft-deleted by default.
// FEAT-23 will use `includePickerHidden` to exclude batch versions whose
// base recipe is soft-deleted, and `isBase` to filter to bases for the base
// picker. The function shape is the contract — extending the branches is
// additive.

export interface PickableRecipesOptions {
  includeDeleted?: boolean;
  // Reserved for FEAT-23. Today a no-op; the rule lands when batch-version-
  // of-deleted-base needs to be excluded from generic pickers.
  includePickerHidden?: boolean;
  // Reserved for FEAT-23 / FEAT-32 (base picker).
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

  // `includePickerHidden` is intentionally not consulted yet — see file
  // header. FEAT-23 fills in the rule.
  void options.includePickerHidden;

  const combined = and(...conditions);
  if (!combined) {
    throw new Error('pickableRecipesWhere produced no conditions');
  }
  return combined;
}
