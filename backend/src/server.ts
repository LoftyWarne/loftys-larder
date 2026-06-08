import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createAuth, type Auth } from './auth/index.ts';
import { createResendSender, withAllowList } from './auth/resend.ts';
import type { MagicLinkSender } from './auth/resend.ts';
import { ConfigValidationError, loadConfig, type Config } from './config.ts';
import { getDb, type Db } from './db/index.ts';
import { buildServerOptions } from './plugins/logger.ts';
import { registerAuth } from './plugins/auth.ts';
import { registerSecurity } from './plugins/security.ts';
import { createContext } from './trpc/context.ts';
import { appRouter } from './trpc/router.ts';

export interface BuildAppOptions {
  // Inject a Drizzle handle in tests; production uses the singleton pool.
  db?: Db;
  // Inject a magic-link sender in tests; production wraps Resend's REST API.
  sendMagicLink?: MagicLinkSender;
}

export async function buildApp(
  config: Config,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify(buildServerOptions(config));

  await registerSecurity(app, config);

  const db = options.db ?? getDb().db;
  app.decorate('db', db);
  app.decorate('cloudinary', {
    cloudName: config.CLOUDINARY_CLOUD_NAME,
    apiKey: config.CLOUDINARY_API_KEY,
    apiSecret: config.CLOUDINARY_API_SECRET,
  });

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

  return app;
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

  const app = await buildApp(config);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
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
