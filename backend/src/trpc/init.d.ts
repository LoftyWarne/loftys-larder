import type { AppContext } from './context.ts';
export declare const router: import("@trpc/server").TRPCRouterBuilder<{
    ctx: AppContext;
    meta: object;
    errorShape: import("@trpc/server").TRPCDefaultErrorShape;
    transformer: false;
}>;
export declare const publicProcedure: import("@trpc/server").TRPCProcedureBuilder<AppContext, object, object, import("@trpc/server").TRPCUnsetMarker, import("@trpc/server").TRPCUnsetMarker, import("@trpc/server").TRPCUnsetMarker, import("@trpc/server").TRPCUnsetMarker, false>;
export declare const middleware: <$ContextOverrides>(fn: import("@trpc/server").TRPCMiddlewareFunction<AppContext, object, object, $ContextOverrides, unknown>) => import("@trpc/server").TRPCMiddlewareBuilder<AppContext, object, $ContextOverrides, unknown>;
//# sourceMappingURL=init.d.ts.map