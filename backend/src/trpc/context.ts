import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';

export interface AppContext {
  req: CreateFastifyContextOptions['req'];
  reply: CreateFastifyContextOptions['res'];
  reqId: string;
  session: null;
}

export function createContext({ req, res }: CreateFastifyContextOptions): AppContext {
  return {
    req,
    reply: res,
    reqId: req.id,
    // FEAT-14 insertion point: resolve the authenticated session here before
    // returning. Until then every request is anonymous.
    session: null,
  };
}
