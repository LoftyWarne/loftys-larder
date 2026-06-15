import { TRPCError } from '@trpc/server';
import { asc, eq } from 'drizzle-orm';
import {
  meSchema,
  updateProfileInputSchema,
  type Me,
} from '../../../../shared/src/schemas/user.ts';
import {
  listHouseholdMembersResultSchema,
  type ListHouseholdMembersResult,
} from '../../../../shared/src/schemas/users.ts';
import { users } from '../../db/schema/auth.ts';
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
});
