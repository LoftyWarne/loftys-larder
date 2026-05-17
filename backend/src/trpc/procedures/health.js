import { publicProcedure, router } from '../init.ts';
export const healthRouter = router({
    ping: publicProcedure.query(({ ctx }) => ({
        ok: true,
        reqId: ctx.reqId,
    })),
});
//# sourceMappingURL=health.js.map