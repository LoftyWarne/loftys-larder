import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import staticPlugin from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import path from 'node:path';
import type { Config } from '../config.ts';

// Explicit CSP per DEC-46. `useDefaults: false` keeps the policy auditable in
// one place rather than splitting it across helmet's defaults and our overrides.
// `style-src 'unsafe-inline'` is a deliberate compromise: Radix UI primitives
// (used by shadcn/ui, DEC-51) inject inline styles for popovers and positioning,
// so a nonce/hash strategy would need every Radix primitive to thread one
// through. Revisit per DEC-46 when tightening style-src becomes worthwhile.
// `script-src` stays strict — adding 'unsafe-inline' there would defeat the
// purpose of the policy.
export interface CspDirectives {
  defaultSrc: string[];
  baseUri: string[];
  formAction: string[];
  frameAncestors: string[];
  objectSrc: string[];
  imgSrc: string[];
  connectSrc: string[];
  scriptSrc: string[];
  styleSrc: string[];
  fontSrc: string[];
  // Helmet's option type is keyed by an arbitrary string with iterable values;
  // the index signature satisfies that contract without losing the explicit
  // shape above.
  [directive: string]: Iterable<string>;
}

export function buildCspDirectives(config: Config): CspDirectives {
  // Direct browser→Cloudinary uploads (DEC-50) POST to api.cloudinary.com,
  // which is a connect-src target. Distinct from res.cloudinary.com in imgSrc,
  // which only covers *displaying* the uploaded image.
  const connectSrc = ["'self'", 'https://api.cloudinary.com'];
  if (config.SENTRY_BROWSER_INGEST_ORIGIN) {
    connectSrc.push(config.SENTRY_BROWSER_INGEST_ORIGIN);
  }

  return {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
    objectSrc: ["'none'"],
    imgSrc: ["'self'", 'https://res.cloudinary.com', 'data:'],
    connectSrc,
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    fontSrc: ["'self'", 'data:'],
  };
}

export async function registerSecurity(
  app: FastifyInstance,
  config: Config,
): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: buildCspDirectives(config),
    },
    // X-Frame-Options is redundant with `frame-ancestors 'none'` for modern
    // browsers but kept as a backup per FEAT-48 AC.
    frameguard: { action: 'deny' },
  });

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
