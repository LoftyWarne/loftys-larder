import type { WithTransaction } from '../withTransaction.ts';
import { seedHousehold } from './household.ts';
import { seedDevRecipes } from './recipes.ts';
import { seedReference } from './reference.ts';

// All seeds run inside a single `withTransaction` (AGENTS.md cross-cutting #4):
// a failure mid-sequence rolls everything back, so a partial-seed state is
// never observable. Idempotency is per-seed via `ON CONFLICT DO NOTHING` or
// explicit existence checks.
//
// `runSeeds` is the **mandatory** seed set shared by tests and the dev CLI:
// household + reference rows that every consumer needs. Optional dev fixtures
// (sample recipes) come from `runDevSeeds` and are only invoked from the dev
// CLI so test fixtures don't collide with seeded data.
export async function runSeeds(
  withTransaction: WithTransaction,
): Promise<void> {
  await withTransaction(async (tx) => {
    await seedHousehold(tx);
    await seedReference(tx);
  });
}

export async function runDevSeeds(
  withTransaction: WithTransaction,
): Promise<void> {
  await withTransaction(async (tx) => {
    await seedDevRecipes(tx);
  });
}
