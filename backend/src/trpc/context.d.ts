import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';
export interface AppContext {
    req: CreateFastifyContextOptions['req'];
    reply: CreateFastifyContextOptions['res'];
    reqId: string;
    session: null;
}
export declare function createContext({ req, res }: CreateFastifyContextOptions): AppContext;
//# sourceMappingURL=context.d.ts.map