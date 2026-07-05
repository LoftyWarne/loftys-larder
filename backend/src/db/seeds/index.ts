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

// Production bootstrap seed, used by the production seed entrypoint
// (`src/seed-reference.ts`) that runs as part of the Fly release command.
// Seeds the single-household row (`CURRENT_HOUSEHOLD_ID`, DEC-17) plus the
// global lookup tables (units, prep types, ingredient categories, meal
// occasions). The household is included because it is the only supported way
// to create it on a fresh prod DB — a re-attach or `DATABASE_URL` repoint
// leaves an empty database and does not re-run migrations' data, so without
// this the first household-scoped write (e.g. creating a plan) fails an FK to
// `households`. Idempotent via per-seed `ON CONFLICT DO NOTHING`, so it is safe
// to run on every deploy.
export async function runReferenceSeeds(
  withTransaction: WithTransaction,
): Promise<void> {
  await withTransaction(async (tx) => {
    await seedHousehold(tx);
    await seedReference(tx);
  });
}
