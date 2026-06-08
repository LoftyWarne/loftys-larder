import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';
import type { Auth } from '../auth/index.ts';
import type { Db } from '../db/index.ts';
import type { CloudinaryCredentials } from '../lib/cloudinary.ts';

// Module augmentation lives here (rather than in the auth plugin) so it's
// always part of any compilation unit that pulls the AppRouter type — notably
// `/shared`, which type-only re-exports the router across the workspace
// boundary.
type AuthSession = NonNullable<
  Awaited<ReturnType<Auth['api']['getSession']>>
>['session'];
type AuthUser = NonNullable<
  Awaited<ReturnType<Auth['api']['getSession']>>
>['user'];

declare module 'fastify' {
  interface FastifyRequest {
    session: AuthSession | null;
    user: AuthUser | null;
  }
  interface FastifyInstance {
    db: Db;
    cloudinary: CloudinaryCredentials;
  }
}

export interface AppContext {
  req: CreateFastifyContextOptions['req'];
  reply: CreateFastifyContextOptions['res'];
  reqId: string;
  db: Db;
  cloudinary: CloudinaryCredentials;
  session: AuthSession | null;
  user: AuthUser | null;
}

export function createContext({
  req,
  res,
}: CreateFastifyContextOptions): AppContext {
  return {
    req,
    reply: res,
    reqId: req.id,
    db: req.server.db,
    cloudinary: req.server.cloudinary,
    // Populated by the auth pre-handler (backend/src/plugins/auth.ts); both
    // are null on unauthenticated routes.
    session: req.session,
    user: req.user,
  };
}
