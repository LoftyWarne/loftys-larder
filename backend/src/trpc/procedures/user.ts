import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import {
  meSchema,
  updateProfileInputSchema,
  type Me,
} from '../../../../shared/src/schemas/user.ts';
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
});
