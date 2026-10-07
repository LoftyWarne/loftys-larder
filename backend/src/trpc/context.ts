import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';
import type { FastifyBaseLogger } from 'fastify';
import type { Auth } from '../auth/index.ts';
import type { Db } from '../db/index.ts';
import type {
  CloudinaryCredentials,
  DestroyImage,
  LookUpImportPdf,
} from '../lib/cloudinary.ts';
import type { PageFetcher } from '../lib/recipe-import/fetch-page.ts';
import type { RecipeReader } from '../lib/recipe-reader/types.ts';
import type { RecipeScorer } from '../lib/recipe-scorer/types.ts';
import type { ModelRateLimitVerdict } from '../plugins/rate-limit.ts';

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
    destroyImage: DestroyImage;
    recipeReader: RecipeReader;
    fetchPage: PageFetcher;
    lookUpImportPdf: LookUpImportPdf;
    recipeScorer: RecipeScorer;
    healthScoreSince: string;
  }
}

export interface RecipeImportContext {
  reader: RecipeReader;
  // Fetches a linked page behind the SSRF guard (DEC-107).
  fetchPage: PageFetcher;
  // Looks an uploaded PDF up in Cloudinary for its page count (DEC-111).
  lookUpPdf: LookUpImportPdf;
  allowStart: () => Promise<ModelRateLimitVerdict>;
}

export interface HealthScoreContext {
  scorer: RecipeScorer;
  // HEALTH_SCORE_SINCE (DEC-112).
  since: string;
  allowScore: () => Promise<ModelRateLimitVerdict>;
}

export interface AppContext {
  req: CreateFastifyContextOptions['req'];
  reply: CreateFastifyContextOptions['res'];
  reqId: string;
  db: Db;
  cloudinary: CloudinaryCredentials;
  // Deletes discarded import images (DEC-107).
  destroyImage: DestroyImage;
  session: AuthSession | null;
  user: AuthUser | null;
  // The request logger, which carries `reqId` (DEC-77).
  log: FastifyBaseLogger;
  recipeImport: RecipeImportContext;
  healthScore: HealthScoreContext;
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
    destroyImage: req.server.destroyImage,
    // Populated by the auth pre-handler (backend/src/plugins/auth.ts); both
    // are null on unauthenticated routes.
    session: req.session,
    user: req.user,
    log: req.log,
    recipeImport: {
      reader: req.server.recipeReader,
      fetchPage: req.server.fetchPage,
      lookUpPdf: req.server.lookUpImportPdf,
      allowStart: () => req.server.limitRecipeImportStart(req),
    },
    healthScore: {
      scorer: req.server.recipeScorer,
      since: req.server.healthScoreSince,
      allowScore: () => req.server.limitHealthScore(req),
    },
  };
}
