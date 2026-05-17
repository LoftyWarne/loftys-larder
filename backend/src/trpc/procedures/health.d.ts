export declare const healthRouter: import("@trpc/server").TRPCBuiltRouter<{
    ctx: import("../context.js").AppContext;
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
//# sourceMappingURL=health.d.ts.map