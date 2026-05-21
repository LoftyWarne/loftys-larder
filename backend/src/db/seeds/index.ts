import type { WithTransaction } from '../withTransaction.ts';
import { seedHousehold } from './household.ts';
import { seedReference } from './reference.ts';

// All seeds run inside a single `withTransaction` (AGENTS.md cross-cutting #4):
// a failure mid-sequence rolls everything back, so a partial-seed state is
// never observable. Idempotency is per-seed via `ON CONFLICT DO NOTHING`.
export async function runSeeds(
  withTransaction: WithTransaction,
): Promise<void> {
  await withTransaction(async (tx) => {
    await seedHousehold(tx);
    await seedReference(tx);
  });
}
