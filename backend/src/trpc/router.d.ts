export declare const appRouter: import("@trpc/server").TRPCBuiltRouter<{
    ctx: import("./context.js").AppContext;
    meta: object;
    errorShape: import("@trpc/server").TRPCDefaultErrorShape;
    transformer: false;
}, import("@trpc/server").TRPCDecorateCreateRouterOptions<{
    health: import("@trpc/server").TRPCBuiltRouter<{
        ctx: import("./context.js").AppContext;
        meta: object;
        errorShape: import("@trpc/server").TRPCDefaultErrorShape;
        transformer: false;
    }, import("@trpc/server").TRPCDecorateCreateRouterOptions<{
        ping: import("@trpc/server").TRPCQueryProcedure<{
            input: void;
            output: {
                ok: true;
                reqId: string;
            };
            meta: object;
        }>;
    }>>;
}>>;
export type AppRouter = typeof appRouter;
//# sourceMappingURL=router.d.ts.map