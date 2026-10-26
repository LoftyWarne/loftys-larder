import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createAuth, type Auth } from './auth/index.ts';
import { createResendSender, withAllowList } from './auth/resend.ts';
import type { SignInCodeSender } from './auth/resend.ts';
import { ConfigValidationError, loadConfig, type Config } from './config.ts';
import { getDb, type Db } from './db/index.ts';
import { createDestroyImage, createLookUpImportPdf } from './lib/cloudinary.ts';
import { createPageFetcher } from './lib/recipe-import/fetch-page.ts';
import { createRecipeReader } from './lib/recipe-reader/index.ts';
import type { RecipeReader } from './lib/recipe-reader/types.ts';
import { createMealPlanner } from './lib/meal-planner/index.ts';
import type { MealPlanner } from './lib/meal-planner/types.ts';
import { createRecipeScorer } from './lib/recipe-scorer/index.ts';
import type { RecipeScorer } from './lib/recipe-scorer/types.ts';
import { buildLoggerBundle } from './plugins/logger.ts';
import type { AxiomDestination } from './plugins/axiom-destination.ts';
import { randomUUID } from 'node:crypto';
import { registerAuth } from './plugins/auth.ts';
import { registerRateLimit } from './plugins/rate-limit.ts';
import { registerSecurity } from './plugins/security.ts';
import { registerSignInLimits } from './plugins/sign-in-limits.ts';
import { TRUSTED_PROXIES } from './plugins/trusted-proxies.ts';
import type { TRPCError } from '@trpc/server';
import {
  captureException,
  initSentry,
  registerSentryHooks,
  shouldReportToSentry,
} from './plugins/sentry.ts';
import { registerHealth } from './routes/health.ts';
import { createContext } from './trpc/context.ts';
import { appRouter } from './trpc/router.ts';

export interface BuildAppOptions {
  // Inject a Drizzle handle in tests; production uses the singleton pool.
  db?: Db;
  // Inject a sign-in code sender in tests; production wraps Resend's REST API.
  sendSignInCode?: SignInCodeSender;
  // Inject the Axiom HTTP transport in tests so the destination can be
  // observed without touching the real ingest endpoint.
  fetchImpl?: typeof fetch;
  // Redirect Pino's stdout sink in tests so the production-mode mirror
  // doesn't leak JSON into test output.
  stdout?: NodeJS.WritableStream;
  // Skip Sentry init in tests where we don't want the global SDK state set.
  skipSentry?: boolean;
  // Inject a Recipe Import reader in tests; production builds the one
  // config names (DEC-109).
  recipeReader?: RecipeReader;
  // Inject a health scorer in tests; production builds the one config names
  // (DEC-112).
  recipeScorer?: RecipeScorer;
  // Inject a meal planner in tests; production builds the one config names
  // (DEC-117).
  mealPlanner?: MealPlanner;
}

export interface BuiltApp {
  app: FastifyInstance;
  axiom: AxiomDestination | null;
}

export async function buildApp(
  config: Config,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const { app } = await buildAppWithLogger(config, options);
  return app;
}

export async function buildAppWithLogger(
  config: Config,
  options: BuildAppOptions = {},
): Promise<BuiltApp> {
  const { logger, axiom } = buildLoggerBundle(config, {
    fetchImpl: options.fetchImpl,
    stdout: options.stdout,
  });
  // Pino's concrete Logger satisfies FastifyBaseLogger structurally; Fastify's
  // generic inference is what narrows on the literal here. Going through a
  // typed local keeps the FastifyInstance generic at its default base logger
  // so registerSecurity / registerAuth / routes stay assignable.
  const baseLogger: FastifyBaseLogger = logger;

  // Initialise Sentry before any Fastify lifecycle runs so its HTTP
  // integration patches `http` ahead of Fastify's listener. A missing DSN
  // makes initSentry a no-op (DEC-76), so a Sentry-free dev/test path stays
  // valid.
  const sentryEnabled =
    !options.skipSentry && initSentry(config, { logger: baseLogger });

  const app = Fastify({
    loggerInstance: baseLogger,
    genReqId: () => randomUUID(),
    disableRequestLogging: false,
    // Rate limits bucket per real client, not per CDN edge, without letting a
    // client pick its own address: `*.fly.dev` is reachable around
    // Cloudflare, so only Fly's proxy and Cloudflare's edges are trusted.
    trustProxy: [...TRUSTED_PROXIES],
    // A batched tRPC query encodes every procedure name into a single
    // `/api/trpc/:path` route param (comma-joined). The planner alone fans out
    // one `plants.forDay` per visible day, so a week-long plan blows past
    // Fastify's default 100-char param cap — the route then misses and the
    // not-found handler answers, which the batch client surfaces as the opaque
    // "Unable to transform response from server". 5000 clears any realistic batch.
    routerOptions: { maxParamLength: 5000 },
  });

  if (sentryEnabled) registerSentryHooks(app);

  await registerSecurity(app, config);

  const db = options.db ?? getDb(app.log).db;
  app.decorate('db', db);
  const cloudinary = {
    cloudName: config.CLOUDINARY_CLOUD_NAME,
    apiKey: config.CLOUDINARY_API_KEY,
    apiSecret: config.CLOUDINARY_API_SECRET,
  };
  app.decorate('cloudinary', cloudinary);
  app.decorate('destroyImage', createDestroyImage(cloudinary));
  app.decorate(
    'recipeReader',
    options.recipeReader ?? createRecipeReader(config),
  );
  app.decorate('fetchPage', createPageFetcher());
  app.decorate('lookUpImportPdf', createLookUpImportPdf(cloudinary));
  app.decorate(
    'recipeScorer',
    options.recipeScorer ?? createRecipeScorer(config),
  );
  app.decorate('healthScoreSince', config.HEALTH_SCORE_SINCE);
  app.decorate('mealPlanner', options.mealPlanner ?? createMealPlanner(config));

  registerHealth(app);

  const transport: SignInCodeSender =
    options.sendSignInCode ??
    // With a fixed code there's nothing to deliver; config keeps it out of
    // production.
    (config.SIGN_IN_CODE_FIXED
      ? ({ to }) => {
          app.log.info(
            { email: to },
            'sign-in code not emailed: SIGN_IN_CODE_FIXED is set',
          );
          return Promise.resolve();
        }
      : createResendSender({
          apiKey: config.RESEND_API_KEY,
          from: config.MAGIC_LINK_FROM,
          log: app.log,
        }));
  const sendSignInCode = withAllowList(
    transport,
    config.MAGIC_LINK_ALLOWED_EMAILS,
    app.log,
  );

  const auth: Auth = createAuth({ config, db, sendSignInCode });
  registerAuth(app, { auth, config });

  await registerRateLimit(
    app,
    config.NODE_ENV === 'test'
      ? {
          ipMaxPerMinute: 10_000,
          sessionMaxPerMinute: 30_000,
          importStartsPerHour: 1_000,
          healthScoresPerHour: 1_000,
          planProposalsPerHour: 1_000,
        }
      : {},
  );
  // After the general limits, so a flood is turned away before it reaches
  // the database. The e2e database outlives a run, so its counts would
  // otherwise carry over between runs.
  registerSignInLimits(app, {
    allowedEmails: config.MAGIC_LINK_ALLOWED_EMAILS,
    ...(config.NODE_ENV === 'test'
      ? {
          sendsPerHour: 1_000,
          entriesPerClientPerHour: 1_000,
          entriesPerHour: 1_000,
        }
      : {}),
  });

  await app.register(fastifyTRPCPlugin, {
    prefix: '/api/trpc',
    trpcOptions: {
      router: appRouter,
      createContext,
      onError: ({
        error,
        path,
      }: {
        error: TRPCError;
        path: string | undefined;
      }) => {
        app.log.error({ err: error, path }, 'tRPC procedure failed');
        // The per-request isolation scope already carries the reqId tag
        // (registerSentryHooks), so a captured server-fault event
        // cross-references the matching Axiom entry (DEC-77).
        if (shouldReportToSentry(error)) captureException(error);
      },
    },
  });

  return { app, axiom };
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const { app, axiom } = await buildAppWithLogger(config);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    // Drain any buffered log batches so the last few seconds reach Axiom.
    if (axiom) await axiom.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    const address = await app.listen({ host: config.HOST, port: config.PORT });
    app.log.info({ address }, 'server listening');
  } catch (error) {
    app.log.error({ err: error }, 'failed to start server');
    process.exit(1);
  }
}

const selfPath = fileURLToPath(import.meta.url);
const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entrypoint === selfPath) {
  void main();
}
