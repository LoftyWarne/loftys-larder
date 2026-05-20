import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ConfigValidationError, loadConfig, type Config } from './config.ts';
import { buildServerOptions } from './plugins/logger.ts';
import { registerSecurity } from './plugins/security.ts';
import { createContext } from './trpc/context.ts';
import { appRouter } from './trpc/router.ts';

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify(buildServerOptions(config));

  await registerSecurity(app, config);

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
