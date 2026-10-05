import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import {
  recipeDraftEnvelopeSchema,
  recipeImportStoredInputSchema,
} from '../../../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../../config.ts';
import type { Db } from '../../db/index.ts';
import { recipeImportOriginals } from '../../db/schema/recipe-import-originals.ts';
import { recipes } from '../../db/schema/recipes.ts';
import type { DestroyImage } from '../cloudinary.ts';

const DESTROY_TIMEOUT_MS = 10_000;

// The image public ids an import draft was started from, in page order.
// Only the import input is read, so a proposal the cook's autosave has made
// unreadable still gives up its images. The input schema keeps the ids to
// the imports folder (DEC-107).
export function importImagePublicIds(draftData: unknown): string[] {
  const envelope = recipeDraftEnvelopeSchema.safeParse(draftData);
  if (!envelope.success) return [];
  const proposal = envelope.data.fields.proposal;
  const input = recipeImportStoredInputSchema.safeParse(
    typeof proposal === 'object' && proposal !== null && 'input' in proposal
      ? proposal.input
      : undefined,
  );
  return input.success && input.data.kind === 'images'
    ? input.data.publicIds
    : [];
}

export interface ImportImageDeps {
  db: Db;
  destroyImage: DestroyImage;
  log: FastifyBaseLogger;
}

// Deletes a discarded import's images: after commit, outside any
// transaction, and best effort, so a failure is logged and never fails the
// caller (DEC-107). An image a saved recipe keeps as an Original is never
// deleted, whatever a draft says.
export async function destroyImportImages(
  { db, destroyImage, log }: ImportImageDeps,
  publicIds: readonly string[],
): Promise<void> {
  if (publicIds.length === 0) return;
  let kept: { publicId: string }[];
  try {
    kept = await db
      .select({ publicId: recipeImportOriginals.publicId })
      .from(recipeImportOriginals)
      .innerJoin(recipes, eq(recipeImportOriginals.recipeId, recipes.id))
      .where(
        and(
          eq(recipes.householdId, CURRENT_HOUSEHOLD_ID),
          inArray(recipeImportOriginals.publicId, [...publicIds]),
        ),
      );
  } catch (err) {
    // Without knowing which images are kept, none are deleted.
    log.warn({ err }, 'Import images not deleted from Cloudinary');
    return;
  }
  const keptIds = new Set(kept.map((row) => row.publicId));
  const discarded = [...new Set(publicIds)].filter((id) => !keptIds.has(id));

  const results = await Promise.allSettled(
    discarded.map((publicId) =>
      destroyImage(publicId, AbortSignal.timeout(DESTROY_TIMEOUT_MS)),
    ),
  );
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      log.warn(
        { err: result.reason, publicId: discarded[index] },
        'Import image not deleted from Cloudinary',
      );
    }
  });
}
