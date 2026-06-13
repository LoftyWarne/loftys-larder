import { TRPCError } from '@trpc/server';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import {
  deleteRecipeDraftInputSchema,
  deleteRecipeDraftResultSchema,
  getNewRecipeDraftsResultSchema,
  getRecipeDraftForRecipeInputSchema,
  getRecipeDraftForRecipeResultSchema,
  recipeDraftEnvelopeSchema,
  upsertRecipeDraftInputSchema,
  upsertRecipeDraftResultSchema,
  type DeleteRecipeDraftResult,
  type GetNewRecipeDraftsResult,
  type GetRecipeDraftForRecipeResult,
  type RecipeDraftEnvelope,
  type UpsertRecipeDraftResult,
} from '../../../../shared/src/index.ts';
import { recipeDrafts } from '../../db/schema/recipe-drafts.ts';
import { protectedProcedure, router } from '../init.ts';

export const recipeDraftsRouter = router({
  upsert: protectedProcedure
    .input(upsertRecipeDraftInputSchema)
    .output(upsertRecipeDraftResultSchema)
    .mutation(async ({ ctx, input }): Promise<UpsertRecipeDraftResult> => {
      const userId = ctx.user.id;
      const { draftId, recipeId, draftData } = input;

      // Targeted update path: caller already knows which row to touch (new-
      // recipe drafts use this so a single row survives repeated autosaves
      // despite the NULL-distinct unique index). Ownership check is enforced
      // in the WHERE clause; if no row matches, return NOT_FOUND so the
      // client can fall back to a fresh insert.
      if (draftId !== undefined) {
        const updated = await ctx.db
          .update(recipeDrafts)
          .set({ draftData, lastUpdatedAt: sql`now()` })
          .where(
            and(eq(recipeDrafts.id, draftId), eq(recipeDrafts.userId, userId)),
          )
          .returning({
            id: recipeDrafts.id,
            lastUpdatedAt: recipeDrafts.lastUpdatedAt,
          });
        const row = updated[0];
        if (!row) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Draft not found',
          });
        }
        return {
          id: row.id,
          lastUpdatedAt: row.lastUpdatedAt.getTime(),
        };
      }

      // `recipeId IS NULL` is allowed for new-recipe drafts. Postgres treats
      // NULLs as distinct in the unique index, so `ON CONFLICT` would not
      // match — fall through to a plain insert and return the new id. The
      // client captures that id and uses the `draftId` path for subsequent
      // updates.
      if (recipeId === null) {
        const inserted = await ctx.db
          .insert(recipeDrafts)
          .values({ userId, recipeId: null, draftData })
          .returning({
            id: recipeDrafts.id,
            lastUpdatedAt: recipeDrafts.lastUpdatedAt,
          });
        const row = inserted[0];
        if (!row) throw new Error('Insert returned no row');
        return {
          id: row.id,
          lastUpdatedAt: row.lastUpdatedAt.getTime(),
        };
      }

      const upserted = await ctx.db
        .insert(recipeDrafts)
        .values({ userId, recipeId, draftData })
        .onConflictDoUpdate({
          target: [recipeDrafts.userId, recipeDrafts.recipeId],
          set: { draftData, lastUpdatedAt: sql`now()` },
        })
        .returning({
          id: recipeDrafts.id,
          lastUpdatedAt: recipeDrafts.lastUpdatedAt,
        });
      const row = upserted[0];
      if (!row) throw new Error('Upsert returned no row');
      return {
        id: row.id,
        lastUpdatedAt: row.lastUpdatedAt.getTime(),
      };
    }),

  getForRecipe: protectedProcedure
    .input(getRecipeDraftForRecipeInputSchema)
    .output(getRecipeDraftForRecipeResultSchema)
    .query(async ({ ctx, input }): Promise<GetRecipeDraftForRecipeResult> => {
      const userId = ctx.user.id;
      const rows = await ctx.db
        .select({
          id: recipeDrafts.id,
          draftData: recipeDrafts.draftData,
          lastUpdatedAt: recipeDrafts.lastUpdatedAt,
        })
        .from(recipeDrafts)
        .where(
          and(
            eq(recipeDrafts.userId, userId),
            eq(recipeDrafts.recipeId, input.recipeId),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      const parsed = parseEnvelope(row.draftData);
      if (!parsed) return null;
      return {
        id: row.id,
        draftData: parsed,
        lastUpdatedAt: row.lastUpdatedAt.getTime(),
      };
    }),

  getNewDrafts: protectedProcedure
    .output(getNewRecipeDraftsResultSchema)
    .query(async ({ ctx }): Promise<GetNewRecipeDraftsResult> => {
      const userId = ctx.user.id;
      const rows = await ctx.db
        .select({
          id: recipeDrafts.id,
          draftData: recipeDrafts.draftData,
          lastUpdatedAt: recipeDrafts.lastUpdatedAt,
        })
        .from(recipeDrafts)
        .where(
          and(eq(recipeDrafts.userId, userId), isNull(recipeDrafts.recipeId)),
        )
        .orderBy(desc(recipeDrafts.lastUpdatedAt));
      const result: GetNewRecipeDraftsResult = [];
      for (const row of rows) {
        const parsed = parseEnvelope(row.draftData);
        if (!parsed) continue;
        result.push({
          id: row.id,
          draftData: parsed,
          lastUpdatedAt: row.lastUpdatedAt.getTime(),
        });
      }
      return result;
    }),

  delete: protectedProcedure
    .input(deleteRecipeDraftInputSchema)
    .output(deleteRecipeDraftResultSchema)
    .mutation(async ({ ctx, input }): Promise<DeleteRecipeDraftResult> => {
      const userId = ctx.user.id;
      const recipeMatch =
        input.recipeId === null
          ? isNull(recipeDrafts.recipeId)
          : eq(recipeDrafts.recipeId, input.recipeId);
      const deleted = await ctx.db
        .delete(recipeDrafts)
        .where(and(eq(recipeDrafts.userId, userId), recipeMatch))
        .returning({ id: recipeDrafts.id });
      return { deleted: deleted.length > 0 };
    }),
});

// `draftData` lives as jsonb and may have been written under a previous
// version of the editor's envelope. Treat a parse failure as "no draft" so
// the editor falls back to server state rather than blowing up. Drops
// version-mismatched rows silently — FEAT-35 cleans them up eventually.
function parseEnvelope(value: unknown): RecipeDraftEnvelope | null {
  const result = recipeDraftEnvelopeSchema.safeParse(value);
  return result.success ? result.data : null;
}
