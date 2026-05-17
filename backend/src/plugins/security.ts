import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import staticPlugin from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Config } from '../config.ts';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const staticPlaceholderDir = path.resolve(moduleDir, '../../public');

export async function registerSecurity(app: FastifyInstance, config: Config): Promise<void> {
  await app.register(helmet);

  if (config.NODE_ENV !== 'production' && config.ALLOWED_ORIGIN) {
    const allowedOrigin = config.ALLOWED_ORIGIN;
    await app.register(cors, {
      origin: (origin, cb) => {
        if (!origin || origin === allowedOrigin) {
          cb(null, true);
          return;
        }
        cb(null, false);
      },
      credentials: true,
    });
  }

  await app.register(staticPlugin, {
    root: staticPlaceholderDir,
    prefix: '/api/static/',
    decorateReply: false,
  });
}
