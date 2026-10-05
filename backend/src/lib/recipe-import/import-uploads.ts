import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import {
  recipeDraftEnvelopeSchema,
  recipeImportStoredInputSchema,
  type RecipeImportStoredInput,
  type RecipeOriginalFormat,
} from '../../../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../../config.ts';
import type { Db } from '../../db/index.ts';
import { recipeImportOriginals } from '../../db/schema/recipe-import-originals.ts';
import { recipes } from '../../db/schema/recipes.ts';
import type { DestroyImage } from '../cloudinary.ts';

const DESTROY_TIMEOUT_MS = 10_000;

// The input an import draft keeps. Only the input is read, so a proposal the
// cook's autosave has made unreadable still gives up its uploads. The input
// schema keeps upload ids to the imports folder (DEC-107).
export function importStoredInput(
  draftData: unknown,
): RecipeImportStoredInput | null {
  const envelope = recipeDraftEnvelopeSchema.safeParse(draftData);
  if (!envelope.success) return null;
  const proposal = envelope.data.fields.proposal;
  const input = recipeImportStoredInputSchema.safeParse(
    typeof proposal === 'object' && proposal !== null && 'input' in proposal
      ? proposal.input
      : undefined,
  );
  return input.success ? input.data : null;
}

export interface ImportUpload {
  publicId: string;
  format: RecipeOriginalFormat;
}

// What an import draft uploaded to Cloudinary: its images in page order, or
// its one PDF (DEC-111).
export function importUploads(draftData: unknown): ImportUpload[] {
  const input = importStoredInput(draftData);
  if (input?.kind === 'images') {
    return input.publicIds.map((publicId) => ({ publicId, format: 'image' }));
  }
  if (input?.kind === 'pdf') {
    return [{ publicId: input.publicId, format: 'pdf' }];
  }
  return [];
}

export interface ImportUploadDeps {
  db: Db;
  destroyImage: DestroyImage;
  log: FastifyBaseLogger;
}

// Deletes a discarded import's uploads: after commit, outside any
// transaction, and best effort, so a failure is logged and never fails the
// caller (DEC-107). An upload a saved recipe keeps as an Original is never
// deleted, whatever a draft says.
export async function destroyImportUploads(
  { db, destroyImage, log }: ImportUploadDeps,
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
    // Without knowing which uploads are kept, none are deleted.
    log.warn({ err }, 'Import uploads not deleted from Cloudinary');
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
        'Import upload not deleted from Cloudinary',
      );
    }
  });
}
