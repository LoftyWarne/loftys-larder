import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createAuth, type Auth } from './auth/index.ts';
import { createResendSender, withAllowList } from './auth/resend.ts';
import type { MagicLinkSender } from './auth/resend.ts';
import { ConfigValidationError, loadConfig, type Config } from './config.ts';
import { getDb, type Db } from './db/index.ts';
import { buildLoggerBundle } from './plugins/logger.ts';
import type { AxiomDestination } from './plugins/axiom-destination.ts';
import { randomUUID } from 'node:crypto';
import { registerAuth } from './plugins/auth.ts';
import { registerRateLimit } from './plugins/rate-limit.ts';
import { registerSecurity } from './plugins/security.ts';
import { initSentry, registerSentryHooks } from './plugins/sentry.ts';
import { registerHealth } from './routes/health.ts';
import { createContext } from './trpc/context.ts';
import { appRouter } from './trpc/router.ts';

export interface BuildAppOptions {
  // Inject a Drizzle handle in tests; production uses the singleton pool.
  db?: Db;
  // Inject a magic-link sender in tests; production wraps Resend's REST API.
  sendMagicLink?: MagicLinkSender;
  // Inject the Axiom HTTP transport in tests so the destination can be
  // observed without touching the real ingest endpoint.
  fetchImpl?: typeof fetch;
  // Redirect Pino's stdout sink in tests so the production-mode mirror
  // doesn't leak JSON into test output.
  stdout?: NodeJS.WritableStream;
  // Skip Sentry init in tests where we don't want the global SDK state set.
  skipSentry?: boolean;
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
    // Honour Cloudflare's forwarded IP headers so rate-limit buckets per
    // real client rather than per CDN edge. We're orange-clouded (DEC-72),
    // so a spoofed header requires bypassing Cloudflare.
    trustProxy: true,
  });

  if (sentryEnabled) registerSentryHooks(app);

  await registerSecurity(app, config);

  const db = options.db ?? getDb().db;
  app.decorate('db', db);
  app.decorate('cloudinary', {
    cloudName: config.CLOUDINARY_CLOUD_NAME,
    apiKey: config.CLOUDINARY_API_KEY,
    apiSecret: config.CLOUDINARY_API_SECRET,
  });

  registerHealth(app);

  const transport: MagicLinkSender =
    options.sendMagicLink ??
    createResendSender({
      apiKey: config.RESEND_API_KEY,
      from: config.MAGIC_LINK_FROM,
      log: app.log,
    });
  const sendMagicLink = withAllowList(
    transport,
    config.MAGIC_LINK_ALLOWED_EMAILS,
    app.log,
  );

  const auth: Auth = createAuth({ config, db, sendMagicLink });
  registerAuth(app, { auth, config });

  await registerRateLimit(app);

  await app.register(fastifyTRPCPlugin, {
    prefix: '/api/trpc',
    trpcOptions: {
      router: appRouter,
      createContext,
      onError: ({
        error,
        path,
      }: {
        error: unknown;
        path: string | undefined;
      }) => {
        app.log.error({ err: error, path }, 'tRPC procedure failed');
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
