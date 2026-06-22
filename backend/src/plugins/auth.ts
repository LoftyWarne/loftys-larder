import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Auth } from '../auth/index.ts';
import type { Config } from '../config.ts';

export interface RegisterAuthOptions {
  auth: Auth;
  config: Config;
}

function isExempt(req: FastifyRequest, config: Config): boolean {
  const url = req.url;
  if (url.startsWith('/api/auth/')) return true;
  if (url.startsWith('/api/health')) return true;
  if (
    config.NODE_ENV !== 'production' &&
    url.startsWith('/api/trpc/health.ping')
  ) {
    return true;
  }
  // The bundled prod backend serves the SPA same-origin via @fastify/static
  // (FEAT-05, `STATIC_DIR`). The SPA shell, its assets, and the SPA fallback
  // for non-/api paths all need to load without a session — the SPA itself
  // routes the user to `/sign-in` client-side. tRPC / Better Auth API calls
  // remain protected because they live under `/api/`.
  if (req.method === 'GET' && !url.startsWith('/api/')) return true;
  return false;
}

function buildHeaders(req: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.append(key, value);
    }
  }
  return headers;
}

export function registerAuth(
  app: FastifyInstance,
  { auth, config }: RegisterAuthOptions,
): void {
  app.decorateRequest('session', null);
  app.decorateRequest('user', null);

  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url: '/api/auth/*',
    async handler(req, reply) {
      const url = new URL(req.url, config.BETTER_AUTH_URL.replace(/\/$/, ''));
      const headers = buildHeaders(req);
      const init: RequestInit = { method: req.method, headers };
      if (
        req.method !== 'GET' &&
        req.method !== 'HEAD' &&
        req.body !== undefined
      ) {
        if (!headers.has('content-type')) {
          headers.set('content-type', 'application/json');
        }
        init.body =
          typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      }

      const response = await auth.handler(new Request(url.toString(), init));

      reply.status(response.status);
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() === 'set-cookie') {
          reply.header('set-cookie', value);
        } else {
          reply.header(key, value);
        }
      });
      const body = response.body ? await response.text() : null;
      await reply.send(body);
    },
  });

  app.addHook(
    'preHandler',
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (req.url.startsWith('/api/auth/')) return;

      const result = await auth.api.getSession({
        headers: buildHeaders(req),
      });

      if (result) {
        req.session = result.session;
        req.user = result.user;
        return;
      }

      if (isExempt(req, config)) return;

      await reply.code(401).send({ error: 'Unauthorized' });
    },
  );
}
