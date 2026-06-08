import { initTRPC, TRPCError } from '@trpc/server';
import { domainErrorCauseSchema } from '../../../shared/src/index.ts';
import type { AppContext } from './context.ts';

// Surface the structured domain `cause` (DEC-35, cross-cutting #11) on the
// wire under `shape.data.cause`. Default tRPC error shape drops `cause`; the
// frontend `getDomainErrorCode` helper reads from this exact path.
const t = initTRPC.context<AppContext>().create({
  errorFormatter({ shape, error }) {
    const parsed = domainErrorCauseSchema.safeParse(error.cause);
    if (!parsed.success) return shape;
    return {
      ...shape,
      data: { ...shape.data, cause: parsed.data },
    };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const middleware = t.middleware;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session || !ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }
  return next({ ctx: { ...ctx, session: ctx.session, user: ctx.user } });
});
