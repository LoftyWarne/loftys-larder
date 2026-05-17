import { publicProcedure, router } from '../init.ts';

export const healthRouter = router({
  ping: publicProcedure.query(({ ctx }) => ({
    ok: true as const,
    reqId: ctx.reqId,
  })),
});
