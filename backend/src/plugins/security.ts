import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import staticPlugin from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import path from 'node:path';
import type { Config } from '../config.ts';

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

  if (config.STATIC_DIR) {
    const staticRoot = path.resolve(config.STATIC_DIR);
    await app.register(staticPlugin, {
      root: staticRoot,
      prefix: '/',
      wildcard: false,
      index: ['index.html'],
    });

    app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not Found' });
    });
  }
}
