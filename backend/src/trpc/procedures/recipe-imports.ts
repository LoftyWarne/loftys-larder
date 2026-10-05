import { TRPCError } from '@trpc/server';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import {
  createRecipeFromImportInputSchema,
  createRecipeFromImportResultSchema,
  discardRecipeImportResultSchema,
  getRecipeImportResultSchema,
  listRecipeImportsResultSchema,
  RECIPE_DRAFT_VERSION,
  RECIPE_IMPORT_PDF_MAX_FILE_SIZE,
  RECIPE_IMPORT_PDF_PAGES_MAX,
  RECIPE_IMPORT_SEVERAL_MAX,
  recipeDraftEnvelopeSchema,
  recipeImportDraftIdInputSchema,
  recipeImportProposalSchema,
  startRecipeImportInputSchema,
  startRecipeImportResultSchema,
  type CreateRecipeFromImportInput,
  type CreateRecipeFromImportResult,
  type DiscardRecipeImportResult,
  type DomainErrorCode,
  type GetRecipeImportResult,
  type ListRecipeImportsResult,
  type RecipeImageView,
  type RecipeImportInput,
  type RecipeImportProposal,
  type RecipeImportStoredInput,
  type StartRecipeImportResult,
} from '../../../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../../config.ts';
import type { Db } from '../../db/index.ts';
import { ingredients } from '../../db/schema/ingredients.ts';
import { recipeDrafts } from '../../db/schema/recipe-drafts.ts';
import { recipeImportOriginals } from '../../db/schema/recipe-import-originals.ts';
import { recipeSources, recipeTags } from '../../db/schema/recipes.ts';
import {
  ingredientCategories,
  preparationTypes,
  unitsOfMeasurement,
} from '../../db/schema/reference.ts';
import { makeWithTransaction, type Tx } from '../../db/withTransaction.ts';
import {
  importImageUrl,
  importPdfPageUrl,
  importPdfUrl,
  type ImportUploadDetails,
} from '../../lib/cloudinary.ts';
import {
  logModelUsage,
  type ModelUsageDetails,
} from '../../lib/model-features/usage-log.ts';
import {
  LinkNotAllowedError,
  PageUnreadableError,
  type FetchedPage,
} from '../../lib/recipe-import/fetch-page.ts';
import {
  destroyImportUploads,
  importStoredInput,
  importUploads,
} from '../../lib/recipe-import/import-uploads.ts';
import { checkImportLink } from '../../lib/recipe-import/link-guard.ts';
import { normaliseProposal } from '../../lib/recipe-import/normalise-proposal.ts';
import {
  readPageContent,
  readPageText,
} from '../../lib/recipe-import/page-content.ts';
import { findPageSourceLink } from '../../lib/recipe-import/page-source-link.ts';
import {
  RecipeReaderRequestError,
  RecipeReaderTimeoutError,
  RecipeReaderUnavailableError,
  type RecipeReaderHousehold,
  type RecipeReaderInput,
  type RecipeReaderUsage,
  type RecipeReading,
} from '../../lib/recipe-reader/types.ts';
import {
  assertIngredientLinesValid,
  assertIngredientsInHousehold,
  assertSourceInHousehold,
  findStepAmountOverTotal,
  insertRecipe,
  toMilli,
  writeIngredientLines,
  writeMethod,
  writeTags,
} from '../../lib/recipe-writes.ts';
import { protectedProcedure, router } from '../init.ts';

// Keeps an import under Cloudflare's 100-second origin limit (DEC-104).
export const RECIPE_IMPORT_TIMEOUT_MS = 75_000;
// Inside the 75 seconds, so a slow Admin API leaves the reader its time.
export const RECIPE_IMPORT_PDF_LOOKUP_TIMEOUT_MS = 10_000;

const FEATURE = 'recipe-import';

type TryAgainReason = 'timeout' | 'unavailable' | 'invalid_proposal';

export const recipeImportsRouter = router({
  // Reads the input into a proposal and writes it into a new import draft
  // (DEC-108). Nothing else is saved, and a failure saves nothing.
  start: protectedProcedure
    .input(startRecipeImportInputSchema)
    .output(startRecipeImportResultSchema)
    .mutation(
      async ({ ctx, input, signal }): Promise<StartRecipeImportResult> => {
        const verdict = await ctx.recipeImport.allowStart();
        if (!verdict.allowed) {
          throw new TRPCError({
            code: 'TOO_MANY_REQUESTS',
            message: 'Too many imports for now',
            cause: {
              code: 'IMPORT_RATE_LIMITED',
              retryAfterSeconds: verdict.retryAfterSeconds,
            },
          });
        }

        const household = await loadReaderHousehold(ctx.db);
        const { reader, fetchPage, lookUpPdf } = ctx.recipeImport;
        const pick = input.pick ?? null;
        // A link's fetch or a PDF's lookup and the read share the one budget
        // (DEC-104).
        const timeout = AbortSignal.timeout(RECIPE_IMPORT_TIMEOUT_MS);
        const importSignal = signal
          ? AbortSignal.any([signal, timeout])
          : timeout;
        const startedAt = performance.now();
        let inputDetails: ModelUsageDetails = {};
        const logUsage = (
          outcome: string,
          usage: RecipeReaderUsage | null,
          details: ModelUsageDetails = {},
        ) => {
          logModelUsage(
            ctx.log,
            {
              feature: FEATURE,
              adapter: reader.adapter,
              model: usage?.model ?? reader.model,
              inputTokens: usage?.inputTokens ?? null,
              outputTokens: usage?.outputTokens ?? null,
              latencyMs: Math.round(performance.now() - startedAt),
              outcome,
            },
            {
              inputKind: input.input.kind,
              picked: pick !== null,
              ...inputDetails,
              ...details,
            },
          );
        };

        let readerInput: RecipeReaderInput;
        // What the draft keeps of the input (DEC-108).
        let storedInput: RecipeImportStoredInput;
        // Takes the place of the reader's own source link: the link the cook
        // gave, or the address a saved page names as its own.
        let sourceUrl: string | null = null;
        if (input.input.kind === 'link') {
          storedInput = input.input;
          sourceUrl = input.input.url;
          const link = checkImportLink(input.input.url);
          if (!link.ok) {
            logUsage('IMPORT_LINK_NOT_ALLOWED', null, { reason: link.reason });
            throw linkNotAllowed();
          }
          // The host only: a link's path and query are the cook's.
          inputDetails = { host: link.url.hostname };
          let page: FetchedPage;
          try {
            page = await fetchPage(link.url, importSignal);
          } catch (error) {
            if (importSignal.aborted) {
              logUsage('IMPORT_TRY_AGAIN', null, { reason: 'timeout' });
              throw tryAgain('timeout');
            }
            if (error instanceof LinkNotAllowedError) {
              logUsage('IMPORT_LINK_NOT_ALLOWED', null, {
                reason: error.reason,
              });
              throw linkNotAllowed();
            }
            if (error instanceof PageUnreadableError) {
              logUsage('IMPORT_LINK_UNREADABLE', null, {
                reason: error.reason,
                pageStatus: error.status,
              });
              throw domainError(
                'UNPROCESSABLE_CONTENT',
                'IMPORT_LINK_UNREADABLE',
                'Couldn’t read that page',
              );
            }
            throw error;
          }
          const content = readPageContent(page.html);
          readerInput = { kind: 'page', url: page.url.href, ...content };
          inputDetails = {
            ...inputDetails,
            pageFormat: content.format,
            pageChars: content.content.length,
            pageTruncated: content.truncated,
            redirects: page.redirects,
            fetchMs: Math.round(performance.now() - startedAt),
          };
        } else if (input.input.kind === 'html') {
          // A saved page is read as a linked one is, without a fetch, so the
          // link guard isn't involved (DEC-111).
          const { fileName, html } = input.input;
          const content = readPageContent(html);
          sourceUrl = findPageSourceLink(html);
          readerInput = { kind: 'page', url: sourceUrl, ...content };
          // Never the markup, which autosave would send back on every edit.
          storedInput = {
            kind: 'html',
            fileName,
            sourceUrl,
            text: readPageText(html),
          };
          // Never the file name or the link's path.
          inputDetails = {
            htmlChars: html.length,
            pageFormat: content.format,
            pageChars: content.content.length,
            pageTruncated: content.truncated,
            ...(sourceUrl === null
              ? {}
              : { host: new URL(sourceUrl).hostname }),
          };
        } else if (input.input.kind === 'pdf') {
          // The page count comes from Cloudinary, never from the browser
          // (DEC-111). The PDF reaches the reader as a URL, never as bytes
          // through Fastify (DEC-50).
          const { publicId } = input.input;
          const lookupSignal = AbortSignal.any([
            importSignal,
            AbortSignal.timeout(RECIPE_IMPORT_PDF_LOOKUP_TIMEOUT_MS),
          ]);
          let upload: ImportUploadDetails | null;
          try {
            upload = await lookUpPdf(publicId, lookupSignal);
          } catch {
            const reason = lookupSignal.aborted ? 'timeout' : 'unavailable';
            logUsage('IMPORT_TRY_AGAIN', null, { reason, pdfLookup: true });
            throw tryAgain(reason);
          }
          inputDetails = {
            lookupMs: Math.round(performance.now() - startedAt),
          };
          const refusal = refusePdf(upload);
          if (upload === null || refusal !== null) {
            logUsage('upload_refused', null, {
              reason: refusal,
              ...(upload === null ? {} : { pdfBytes: upload.bytes }),
            });
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'That upload can’t be imported',
            });
          }
          if (upload.pages === null) {
            logUsage('IMPORT_TRY_AGAIN', null, {
              reason: 'unavailable',
              pdfLookup: true,
            });
            throw tryAgain('unavailable');
          }
          const pageCount = upload.pages;
          inputDetails = {
            ...inputDetails,
            pdfPages: pageCount,
            pdfBytes: upload.bytes,
          };
          if (pageCount > RECIPE_IMPORT_PDF_PAGES_MAX) {
            logUsage('IMPORT_DOCUMENT_TOO_LONG', null);
            throw domainError(
              'BAD_REQUEST',
              'IMPORT_DOCUMENT_TOO_LONG',
              'That PDF has too many pages',
              { pageCount, maxPages: RECIPE_IMPORT_PDF_PAGES_MAX },
            );
          }
          readerInput = {
            kind: 'pdf',
            url: importPdfUrl(ctx.cloudinary.cloudName, publicId),
          };
          storedInput = { kind: 'pdf', publicId, pageCount };
        } else {
          storedInput = input.input;
          readerInput = toReaderInput(input.input, ctx.cloudinary.cloudName);
          if (readerInput.kind === 'images') {
            inputDetails = { imageCount: readerInput.urls.length };
          }
        }

        let reading: RecipeReading;
        try {
          reading = await reader.read(
            { input: readerInput, household, pick },
            importSignal,
          );
        } catch (error) {
          if (error instanceof RecipeReaderTimeoutError) {
            logUsage('IMPORT_TRY_AGAIN', null, { reason: 'timeout' });
            throw tryAgain('timeout');
          }
          if (error instanceof RecipeReaderUnavailableError) {
            logUsage('IMPORT_TRY_AGAIN', null, {
              reason: 'unavailable',
              providerStatus: error.status,
            });
            throw tryAgain('unavailable');
          }
          // Our request was wrong, so the cook isn't told to try again and
          // the provider's reason is kept for whoever fixes it. It reaches
          // Sentry with the domain code only.
          if (error instanceof RecipeReaderRequestError) {
            logUsage('IMPORT_REQUEST_REJECTED', null, {
              providerStatus: error.status,
              providerErrorType: error.providerErrorType,
              providerMessage: error.providerMessage,
              providerRequestId: error.providerRequestId,
            });
            throw domainError(
              'INTERNAL_SERVER_ERROR',
              'IMPORT_REQUEST_REJECTED',
              'The recipe reader refused the request',
            );
          }
          throw error;
        }

        const { outcome, usage } = reading;
        if (outcome.kind === 'not_a_recipe') {
          logUsage('IMPORT_NOT_A_RECIPE', usage);
          throw new TRPCError({
            code: 'UNPROCESSABLE_CONTENT',
            message: 'That doesn’t look like a recipe',
            cause: { code: 'IMPORT_NOT_A_RECIPE' },
          });
        }

        if (outcome.kind === 'several') {
          const names = severalNames(outcome.names);
          // A second "several" after a pick, or fewer than two usable names,
          // leaves nothing to choose from.
          if (pick !== null || names.length < 2) {
            logUsage('IMPORT_TRY_AGAIN', usage, { reason: 'invalid_proposal' });
            throw tryAgain('invalid_proposal');
          }
          logUsage('several', usage, { severalCount: names.length });
          return { kind: 'several', names };
        }

        const normalised = normaliseProposal(outcome.candidate, household);
        if (!normalised.ok) {
          logUsage('IMPORT_TRY_AGAIN', usage, {
            reason: 'invalid_proposal',
            invalidPaths: normalised.issues.join(','),
          });
          throw tryAgain('invalid_proposal');
        }

        const proposal: RecipeImportProposal = {
          ...normalised.proposal,
          header:
            sourceUrl === null
              ? normalised.proposal.header
              : { ...normalised.proposal.header, sourceUrl },
          reader: { adapter: reader.adapter, model: usage.model },
          input: storedInput,
        };
        const inserted = await ctx.db
          .insert(recipeDrafts)
          .values({
            userId: ctx.user.id,
            recipeId: null,
            kind: 'import',
            draftData: {
              version: RECIPE_DRAFT_VERSION,
              fields: { proposal },
            },
          })
          .returning({ id: recipeDrafts.id });
        const row = inserted[0];
        if (!row) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Insert returned no row',
          });
        }
        logUsage('draft', usage);
        return { kind: 'draft', draftId: row.id };
      },
    ),

  // The user's imports in progress, newest first. Import drafts don't expire
  // (DEC-108).
  list: protectedProcedure
    .output(listRecipeImportsResultSchema)
    .query(async ({ ctx }): Promise<ListRecipeImportsResult> => {
      const rows = await ctx.db
        .select({
          id: recipeDrafts.id,
          draftData: recipeDrafts.draftData,
          lastUpdatedAt: recipeDrafts.lastUpdatedAt,
        })
        .from(recipeDrafts)
        .where(ownImportDrafts(ctx.user.id))
        .orderBy(desc(recipeDrafts.lastUpdatedAt), desc(recipeDrafts.id));
      return rows.map((row) => {
        const proposal = readProposal(row.draftData);
        return {
          id: row.id,
          name: proposal?.header.name ?? null,
          inputKind: proposal?.input.kind ?? null,
          lastUpdatedAt: row.lastUpdatedAt.getTime(),
        };
      });
    }),

  get: protectedProcedure
    .input(recipeImportDraftIdInputSchema)
    .output(getRecipeImportResultSchema)
    .query(async ({ ctx, input }): Promise<GetRecipeImportResult> => {
      const rows = await ctx.db
        .select({
          id: recipeDrafts.id,
          draftData: recipeDrafts.draftData,
          lastUpdatedAt: recipeDrafts.lastUpdatedAt,
        })
        .from(recipeDrafts)
        .where(
          and(eq(recipeDrafts.id, input.draftId), ownImportDrafts(ctx.user.id)),
        )
        .limit(1);
      const row = rows[0];
      const envelope = row
        ? recipeDraftEnvelopeSchema.safeParse(row.draftData)
        : null;
      if (!row || !envelope?.success) throw importNotFound();
      return {
        id: row.id,
        proposal: readProposal(row.draftData),
        images: reviewImages(row.draftData, ctx.cloudinary.cloudName),
        draftData: envelope.data,
        lastUpdatedAt: row.lastUpdatedAt.getTime(),
      };
    }),

  // An image import's images, or a PDF import's PDF, go with it once the
  // draft is gone (DEC-107, DEC-111).
  discard: protectedProcedure
    .input(recipeImportDraftIdInputSchema)
    .output(discardRecipeImportResultSchema)
    .mutation(async ({ ctx, input }): Promise<DiscardRecipeImportResult> => {
      const deleted = await ctx.db
        .delete(recipeDrafts)
        .where(
          and(eq(recipeDrafts.id, input.draftId), ownImportDrafts(ctx.user.id)),
        )
        .returning({ draftData: recipeDrafts.draftData });
      await destroyImportUploads(
        ctx,
        deleted.flatMap((row) =>
          importUploads(row.draftData).map((upload) => upload.publicId),
        ),
      );
      return { deleted: deleted.length > 0 };
    }),

  // Writes the reviewed recipe and everything new it needs in one
  // transaction, then the import is gone (DEC-108). The server never reads
  // the draft's fields: the client sends what the cook reviewed.
  createRecipe: protectedProcedure
    .input(createRecipeFromImportInputSchema)
    .output(createRecipeFromImportResultSchema)
    .mutation(async ({ ctx, input }): Promise<CreateRecipeFromImportResult> => {
      const draft = await ctx.db
        .select({ id: recipeDrafts.id })
        .from(recipeDrafts)
        .where(
          and(eq(recipeDrafts.id, input.draftId), ownImportDrafts(ctx.user.id)),
        )
        .limit(1);
      if (draft.length === 0) throw importNotFound();

      await assertIngredientLinesValid(
        ctx.db,
        input.lines.flatMap((line) =>
          'id' in line.ingredient
            ? [
                {
                  ingredientId: line.ingredient.id,
                  unitId: line.ingredient.unitId,
                },
              ]
            : [],
        ),
      );
      await assertIngredientsInHousehold(
        ctx.db,
        input.steps.flatMap((step) =>
          step.ingredients.flatMap((link) =>
            'id' in link.ingredient ? [link.ingredient.id] : [],
          ),
        ),
      );
      if (input.source !== null && 'id' in input.source) {
        await assertSourceInHousehold(ctx.db, input.source.id);
      }
      assertStepAmountsWithinLines(input);

      const usedKeys = new Set(
        [
          ...input.lines.map((line) => line.ingredient),
          ...input.steps.flatMap((step) =>
            step.ingredients.map((link) => link.ingredient),
          ),
        ].flatMap((ref) => ('newKey' in ref ? [ref.newKey] : [])),
      );

      const withTransaction = makeWithTransaction(ctx.db);
      const recipeId = await withTransaction(async (tx) => {
        // Claimed first: a second "Create recipe" for the same import
        // waits on this row, finds it gone and rolls back.
        const claimed = await tx
          .delete(recipeDrafts)
          .where(
            and(
              eq(recipeDrafts.id, input.draftId),
              ownImportDrafts(ctx.user.id),
            ),
          )
          .returning({ draftData: recipeDrafts.draftData });
        const claimedDraft = claimed[0];
        if (!claimedDraft) throw importNotFound();

        const sourceId = await resolveSource(tx, input.source);
        const idByKey = await insertNewIngredients(
          tx,
          input.newIngredients.filter((ingredient) =>
            usedKeys.has(ingredient.key),
          ),
        );
        const ingredientId = (ref: { id: number } | { newKey: string }) => {
          if ('id' in ref) return ref.id;
          const id = idByKey.get(ref.newKey);
          if (id === undefined) throw new Error('Unresolved new ingredient');
          return id;
        };

        // Standalone only: never a base or a serving variation (DEC-103).
        const id = await insertRecipe(
          tx,
          { ...input.header, sourceId, isBase: false },
          ctx.user.id,
        );
        await writeIngredientLines(
          tx,
          id,
          input.lines.map((line) => ({
            ingredientId: ingredientId(line.ingredient),
            quantity: line.quantity,
            prepTypeId: line.prepTypeId,
            isOptional: line.isOptional,
          })),
        );
        await writeMethod(
          tx,
          id,
          input.steps.map((step) => ({
            ...step,
            ingredients: step.ingredients.map((link) => ({
              ingredientId: ingredientId(link.ingredient),
              quantity: link.quantity,
            })),
          })),
        );
        await writeTags(tx, id, input.tagNames);

        // The import's images, or its PDF, are kept as the recipe's
        // Originals, never as its image (DEC-107, DEC-111). They're read from
        // the proposal, which the server wrote, not from anything the editor
        // owns (DEC-108).
        const uploads = importUploads(claimedDraft.draftData);
        if (uploads.length > 0) {
          await tx.insert(recipeImportOriginals).values(
            uploads.map((upload, position) => ({
              recipeId: id,
              position,
              publicId: upload.publicId,
              format: upload.format,
            })),
          );
        }
        return id;
      });

      return { recipeId };
    }),
});

function ownImportDrafts(userId: string) {
  return and(eq(recipeDrafts.userId, userId), eq(recipeDrafts.kind, 'import'));
}

// Images reach the reader as delivery URLs for their JPEG rendition, never
// as bytes through Fastify (DEC-50, DEC-107).
function toReaderInput(
  input: Extract<RecipeImportInput, { kind: 'text' | 'images' }>,
  cloudName: string,
): RecipeReaderInput {
  if (input.kind === 'text') return input;
  return {
    kind: 'images',
    urls: input.publicIds.map((publicId) =>
      importImageUrl(cloudName, publicId),
    ),
  };
}

// Why an uploaded PDF can't be read, if it can't. The size is checked again
// because Cloudinary can't enforce it on this plan.
function refusePdf(
  upload: ImportUploadDetails | null,
): 'not_found' | 'not_pdf' | 'too_big' | null {
  if (upload === null) return 'not_found';
  if (upload.format !== 'pdf') return 'not_pdf';
  if (upload.bytes > RECIPE_IMPORT_PDF_MAX_FILE_SIZE) return 'too_big';
  return null;
}

// What Import Review shows of an import's uploads: an image import's
// renditions, or a PDF's pages as JPEGs, in page order.
function reviewImages(
  draftData: unknown,
  cloudName: string,
): RecipeImageView[] {
  const input = importStoredInput(draftData);
  if (input?.kind === 'images') {
    return input.publicIds.map((publicId) => ({
      url: importImageUrl(cloudName, publicId),
    }));
  }
  if (input?.kind === 'pdf') {
    return Array.from({ length: input.pageCount }, (_, index) => ({
      url: importPdfPageUrl(cloudName, input.publicId, index + 1),
    }));
  }
  return [];
}

// The proposal the server wrote, if the draft still holds a readable one.
function readProposal(draftData: unknown): RecipeImportProposal | null {
  const envelope = recipeDraftEnvelopeSchema.safeParse(draftData);
  if (!envelope.success) return null;
  const proposal = recipeImportProposalSchema.safeParse(
    envelope.data.fields.proposal,
  );
  return proposal.success ? proposal.data : null;
}

// The household lists a reader may refer to (DEC-17, DEC-105). Categories,
// units and prep types are global reference tables.
async function loadReaderHousehold(db: Db): Promise<RecipeReaderHousehold> {
  const [householdIngredients, categories, units, prepTypes, tags, sources] =
    await Promise.all([
      db
        .select({
          id: ingredients.id,
          name: ingredients.name,
          unitId: unitsOfMeasurement.id,
          unitName: unitsOfMeasurement.name,
        })
        .from(ingredients)
        .innerJoin(
          unitsOfMeasurement,
          eq(ingredients.defaultUnitId, unitsOfMeasurement.id),
        )
        .where(eq(ingredients.householdId, CURRENT_HOUSEHOLD_ID))
        .orderBy(asc(ingredients.name)),
      db
        .select({
          id: ingredientCategories.id,
          name: ingredientCategories.name,
        })
        .from(ingredientCategories)
        .orderBy(asc(ingredientCategories.name)),
      db
        .select({ id: unitsOfMeasurement.id, name: unitsOfMeasurement.name })
        .from(unitsOfMeasurement)
        .orderBy(asc(unitsOfMeasurement.name)),
      db
        .select({ id: preparationTypes.id, name: preparationTypes.name })
        .from(preparationTypes)
        .orderBy(asc(preparationTypes.name)),
      db
        .select({ id: recipeTags.id, name: recipeTags.name })
        .from(recipeTags)
        .where(eq(recipeTags.householdId, CURRENT_HOUSEHOLD_ID))
        .orderBy(asc(recipeTags.name)),
      db
        .select({ id: recipeSources.id, name: recipeSources.name })
        .from(recipeSources)
        .where(eq(recipeSources.householdId, CURRENT_HOUSEHOLD_ID))
        .orderBy(asc(recipeSources.name)),
    ]);
  return {
    ingredients: householdIngredients,
    categories,
    units,
    prepTypes,
    tags,
    sources,
  };
}

function severalNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (name.length === 0 || name.length > 200) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result.slice(0, RECIPE_IMPORT_SEVERAL_MAX);
}

// Step amounts can't add up to more than the lines being created
// (DEC-99), the same rule `replaceMethod` applies to saved lines.
function assertStepAmountsWithinLines(
  input: CreateRecipeFromImportInput,
): void {
  const metadataByKey = new Map<string, Record<string, unknown>>();
  const refKey = (ref: { id: number } | { newKey: string }) => {
    const key = 'id' in ref ? `id:${String(ref.id)}` : `new:${ref.newKey}`;
    metadataByKey.set(
      key,
      'id' in ref ? { ingredientId: ref.id } : { newKey: ref.newKey },
    );
    return key;
  };
  const totals = new Map<string, number>();
  for (const line of input.lines) {
    const key = refKey(line.ingredient);
    totals.set(key, (totals.get(key) ?? 0) + toMilli(line.quantity));
  }
  const over = findStepAmountOverTotal(
    input.steps.flatMap((step) =>
      step.ingredients.map((link) => ({
        key: refKey(link.ingredient),
        quantity: link.quantity,
      })),
    ),
    totals,
  );
  if (!over) return;
  throw domainError(
    'BAD_REQUEST',
    'RECIPE_STEP_AMOUNT_EXCEEDS_TOTAL',
    'Step amounts add up to more than the recipe uses',
    {
      ...metadataByKey.get(over.key),
      stated: over.stated,
      total: over.total,
    },
  );
}

// A source proposed by name links to one that now exists with that name,
// rather than failing (DEC-105 names only ingredients as an error).
async function resolveSource(
  tx: Tx,
  source: CreateRecipeFromImportInput['source'],
): Promise<number | null> {
  if (source === null) return null;
  if ('id' in source) return source.id;
  const findByName = () =>
    tx
      .select({ id: recipeSources.id })
      .from(recipeSources)
      .where(
        and(
          eq(recipeSources.householdId, CURRENT_HOUSEHOLD_ID),
          eq(sql`lower(${recipeSources.name})`, source.newName.toLowerCase()),
        ),
      )
      .limit(1);
  const existing = await findByName();
  if (existing[0]) return existing[0].id;
  await tx
    .insert(recipeSources)
    .values({ householdId: CURRENT_HOUSEHOLD_ID, name: source.newName })
    .onConflictDoNothing();
  const created = await findByName();
  if (!created[0]) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Source insert returned no row',
    });
  }
  return created[0].id;
}

// New ingredients are created one at a time, so a name taken since the
// import (DEC-105) is reported against the row that proposed it.
async function insertNewIngredients(
  tx: Tx,
  proposed: CreateRecipeFromImportInput['newIngredients'],
): Promise<Map<string, number>> {
  const idByKey = new Map<string, number>();
  if (proposed.length === 0) return idByKey;

  const taken = await tx
    .select({ name: ingredients.name })
    .from(ingredients)
    .where(
      and(
        eq(ingredients.householdId, CURRENT_HOUSEHOLD_ID),
        inArray(
          sql`lower(${ingredients.name})`,
          proposed.map((ingredient) => ingredient.name.toLowerCase()),
        ),
      ),
    );
  const takenNames = new Set(taken.map((row) => row.name.toLowerCase()));
  const clash = proposed.find((ingredient) =>
    takenNames.has(ingredient.name.toLowerCase()),
  );
  if (clash) throw ingredientNameTaken(clash.key);

  for (const ingredient of proposed) {
    let inserted: { id: number }[];
    try {
      inserted = await tx
        .insert(ingredients)
        .values({
          householdId: CURRENT_HOUSEHOLD_ID,
          name: ingredient.name,
          categoryId: ingredient.categoryId,
          defaultUnitId: ingredient.defaultUnitId,
          isPlant: ingredient.isPlant,
          averageShelfLifeDays: ingredient.averageShelfLifeDays,
        })
        .returning({ id: ingredients.id });
    } catch (error) {
      if (isUniqueViolation(error, 'ingredients_household_lower_name_unique')) {
        throw ingredientNameTaken(ingredient.key);
      }
      throw error;
    }
    const row = inserted[0];
    if (!row) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Insert returned no row',
      });
    }
    idByKey.set(ingredient.key, row.id);
  }
  return idByKey;
}

function ingredientNameTaken(newKey: string): TRPCError {
  return domainError(
    'CONFLICT',
    'INGREDIENT_NAME_TAKEN',
    'An ingredient with this name already exists',
    { newKey },
  );
}

function linkNotAllowed(): TRPCError {
  return domainError(
    'BAD_REQUEST',
    'IMPORT_LINK_NOT_ALLOWED',
    'That link can’t be imported',
  );
}

function importNotFound(): TRPCError {
  return new TRPCError({ code: 'NOT_FOUND', message: 'Import not found' });
}

// Timeouts, outages and unusable proposals are server-side failures, so they
// reach Sentry, with the domain code and reason only (DEC-104).
function tryAgain(reason: TryAgainReason): TRPCError {
  const code =
    reason === 'timeout'
      ? 'GATEWAY_TIMEOUT'
      : reason === 'unavailable'
        ? 'SERVICE_UNAVAILABLE'
        : 'BAD_GATEWAY';
  return domainError(code, 'IMPORT_TRY_AGAIN', 'The import didn’t work', {
    reason,
  });
}

function domainError(
  code: TRPCError['code'],
  domainCode: DomainErrorCode,
  message: string,
  metadata: Record<string, unknown> = {},
): TRPCError {
  return new TRPCError({
    code,
    message,
    cause: { code: domainCode, ...metadata },
  });
}

// PG SQLSTATE 23505 = unique_violation, with the constraint/index name on
// `error.constraint`. Drizzle wraps driver errors, so walk the cause chain.
function isUniqueViolation(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current !== 'object') return false;
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (candidate.code === '23505' && candidate.constraint === constraint) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}
