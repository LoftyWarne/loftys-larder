import { CURRENT_HOUSEHOLD_ID } from '../../config.ts';
import { households } from '../schema/household.ts';
import type { Tx } from '../withTransaction.ts';

const HOUSEHOLD_NAME = "Lofty's Larder";

export async function seedHousehold(tx: Tx): Promise<void> {
  await tx
    .insert(households)
    .values({ id: CURRENT_HOUSEHOLD_ID, name: HOUSEHOLD_NAME })
    .onConflictDoNothing({ target: households.id });
}
