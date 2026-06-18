import { TRPCError } from '@trpc/server';
import { and, asc, count, eq } from 'drizzle-orm';
import {
  deleteAccountInputSchema,
  deleteAccountResultSchema,
  deletionSummarySchema,
  meSchema,
  updateProfileInputSchema,
  type DeleteAccountResult,
  type DeletionSummary,
  type Me,
} from '../../../../shared/src/schemas/user.ts';
import {
  listHouseholdMembersResultSchema,
  type ListHouseholdMembersResult,
} from '../../../../shared/src/schemas/users.ts';
import { users, verifications } from '../../db/schema/auth.ts';
import { mealPlans, mealPlanSlots } from '../../db/schema/meal-plans.ts';
import { recipeDrafts } from '../../db/schema/recipe-drafts.ts';
import {
  recipeComments,
  recipeRatings,
} from '../../db/schema/recipe-social.ts';
import { recipes } from '../../db/schema/recipes.ts';
import { makeWithTransaction } from '../../db/withTransaction.ts';
import { protectedProcedure, router } from '../init.ts';

export const userRouter = router({
  getMe: protectedProcedure
    .output(meSchema)
    .query(async ({ ctx }): Promise<Me> => {
      const row = await ctx.db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          themePreference: users.themePreference,
        })
        .from(users)
        .where(eq(users.id, ctx.user.id))
        .limit(1);

      const me = row[0];
      if (!me) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User row missing for authenticated session',
        });
      }
      return me;
    }),

  updateProfile: protectedProcedure
    .input(updateProfileInputSchema)
    .output(meSchema)
    .mutation(async ({ ctx, input }): Promise<Me> => {
      const patch: {
        name?: string;
        themePreference?: 'system' | 'light' | 'dark';
      } = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.themePreference !== undefined) {
        patch.themePreference = input.themePreference;
      }

      const updated = await ctx.db
        .update(users)
        .set(patch)
        .where(eq(users.id, ctx.user.id))
        .returning({
          id: users.id,
          email: users.email,
          name: users.name,
          themePreference: users.themePreference,
        });

      const me = updated[0];
      if (!me) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User row missing for authenticated session',
        });
      }
      return me;
    }),

  // Members eligible for the planner's chef dropdown. Single-household MVP
  // (DEC-17): every auth user is implicitly a member. When multi-household
  // lands, this query gains a household_members join — the wire shape doesn't
  // change.
  listHouseholdMembers: protectedProcedure
    .output(listHouseholdMembersResultSchema)
    .query(async ({ ctx }): Promise<ListHouseholdMembersResult> => {
      const rows = await ctx.db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
        })
        .from(users)
        .orderBy(asc(users.name));
      return { members: rows };
    }),

  // Counts the shared-household records that will be tombstoned (rendered as
  // "[deleted user]" after deletion). Hard-deleted records (ratings, drafts)
  // are excluded — the user already knows about their own personal data.
  // Soft-deleted recipes are also excluded so the count matches what other
  // household members can still see.
  getDeletionSummary: protectedProcedure
    .output(deletionSummarySchema)
    .query(async ({ ctx }): Promise<DeletionSummary> => {
      const [commentRow, recipeRow, planRow] = await Promise.all([
        ctx.db
          .select({ value: count() })
          .from(recipeComments)
          .where(eq(recipeComments.userId, ctx.user.id)),
        ctx.db
          .select({ value: count() })
          .from(recipes)
          .where(
            and(
              eq(recipes.addedByUserId, ctx.user.id),
              eq(recipes.isDeleted, false),
            ),
          ),
        ctx.db
          .select({ value: count() })
          .from(mealPlans)
          .where(eq(mealPlans.createdByUserId, ctx.user.id)),
      ]);
      return {
        commentCount: commentRow[0]?.value ?? 0,
        recipeCount: recipeRow[0]?.value ?? 0,
        planCount: planRow[0]?.value ?? 0,
      };
    }),

  // Account-deletion tombstoning (DEC-29, FEAT spec lines 1414–1448). The
  // sequence is fixed and must hit *every* user-FK'd table: if a future feature
  // adds another, extend this block at the same time (cross-cutting #15).
  // Ordering matters — RESTRICT FKs (`recipe_ratings`, `recipe_drafts`) must be
  // cleared before the final `DELETE FROM users`, which then cascades to
  // Better Auth's `sessions` / `accounts`. `verifications` is keyed by email,
  // not user id, so we sweep it explicitly.
  deleteAccount: protectedProcedure
    .input(deleteAccountInputSchema)
    .output(deleteAccountResultSchema)
    .mutation(async ({ ctx, input }): Promise<DeleteAccountResult> => {
      if (input.emailConfirmation !== ctx.user.email) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Email confirmation does not match your account email.',
          cause: { code: 'ACCOUNT_DELETE_EMAIL_MISMATCH' },
        });
      }

      const userId = ctx.user.id;
      const email = ctx.user.email;

      const withTransaction = makeWithTransaction(ctx.db);
      await withTransaction(async (tx) => {
        // 1. Hard-delete personal ratings (RESTRICT FK).
        await tx.delete(recipeRatings).where(eq(recipeRatings.userId, userId));

        // 2. NULL the comment author; comment text remains as
        //    "[deleted user] said …" in the UI.
        await tx
          .update(recipeComments)
          .set({ userId: null })
          .where(eq(recipeComments.userId, userId));

        // 3. NULL recipe authorship; the recipe survives for past plans.
        await tx
          .update(recipes)
          .set({ addedByUserId: null })
          .where(eq(recipes.addedByUserId, userId));

        // 4. NULL plan authorship; the plan survives.
        await tx
          .update(mealPlans)
          .set({ createdByUserId: null })
          .where(eq(mealPlans.createdByUserId, userId));

        // 5. NULL slot chef attribution.
        await tx
          .update(mealPlanSlots)
          .set({ chefUserId: null })
          .where(eq(mealPlanSlots.chefUserId, userId));

        // 6. Hard-delete in-progress recipe drafts (RESTRICT FK).
        await tx.delete(recipeDrafts).where(eq(recipeDrafts.userId, userId));

        // Better Auth's verification tokens are keyed by email, not user id —
        // sweep any outstanding magic-link rows for this address.
        await tx
          .delete(verifications)
          .where(eq(verifications.identifier, email));

        // 7. Delete the user row. `sessions` and `accounts` cascade.
        await tx.delete(users).where(eq(users.id, userId));
      });

      return { deleted: true };
    }),
});
