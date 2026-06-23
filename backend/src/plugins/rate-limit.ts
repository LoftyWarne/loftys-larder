import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const RATE_LIMITED_CODE = 'RATE_LIMITED';
const MAGIC_LINK_SEND_PATH = '/api/auth/sign-in/magic-link';

interface RateLimitedBody {
  error: 'TooManyRequests';
  code: typeof RATE_LIMITED_CODE;
  retryAfterSeconds: number;
}

function isMagicLinkSendRoute(req: FastifyRequest): boolean {
  if (req.method !== 'POST') return false;
  const path = req.url.split('?', 1)[0];
  return path === MAGIC_LINK_SEND_PATH;
}

function isExempt(req: FastifyRequest): boolean {
  // Fly hits /api/health every few seconds for liveness; counting those
  // toward the IP bucket would 429 the platform's probes.
  return req.url.startsWith('/api/health');
}

function extractMagicLinkEmail(req: FastifyRequest): string | null {
  const body = req.body;
  if (!body || typeof body !== 'object') return null;
  const value = (body as Record<string, unknown>).email;
  if (typeof value !== 'string') return null;
  const normalised = value.trim().toLowerCase();
  return normalised.length > 0 ? normalised : null;
}

async function sendRateLimited(
  reply: FastifyReply,
  ttlInSeconds: number,
): Promise<void> {
  const body: RateLimitedBody = {
    error: 'TooManyRequests',
    code: RATE_LIMITED_CODE,
    retryAfterSeconds: ttlInSeconds,
  };
  reply.header('retry-after', ttlInSeconds);
  reply.code(429);
  await reply.send(body);
}

export interface RateLimitOptions {
  // Per-minute caps for the global IP/session bucket. Defaults match
  // production sizing; the rate-limit unit tests assert behaviour against
  // these defaults so they must remain stable. `server.ts` overrides them
  // upward under NODE_ENV=test so the e2e suite (axe scans across many
  // navigations) doesn't trip the IP bucket via /api/auth/get-session — the
  // auth preHandler skips that path, so its requests never get the
  // higher sessioned credit.
  ipMaxPerMinute?: number;
  sessionMaxPerMinute?: number;
}

export async function registerRateLimit(
  app: FastifyInstance,
  options: RateLimitOptions = {},
): Promise<void> {
  const ipMax = options.ipMaxPerMinute ?? 100;
  const sessionMax = options.sessionMaxPerMinute ?? 300;

  // Register the plugin so `createRateLimit` is decorated, but with
  // global: false — we drive the per-request check from a single preHandler
  // hook below so the 429 response shape stays under our control instead of
  // going through the plugin's `errorResponseBuilder` + Fastify error pipeline.
  await app.register(rateLimit, { global: false });

  const checkGlobal = app.createRateLimit({
    max: (req) => (req.session ? sessionMax : ipMax),
    timeWindow: '1 minute',
    keyGenerator: (req) =>
      req.session ? `session:${req.session.id}` : `ip:${req.ip}`,
  });

  // Per-email cap on the magic-link send endpoint. Better Auth owns the route
  // via a wildcard handler (backend/src/plugins/auth.ts) so we cannot use the
  // plugin's per-route `config.rateLimit`; a hook scoped to the path+method is
  // the workaround the spec calls for.
  const checkMagicLink = app.createRateLimit({
    max: 5,
    timeWindow: '1 hour',
    keyGenerator: (req) => {
      const email = extractMagicLinkEmail(req);
      return email ? `magic-email:${email}` : `magic-ip:${req.ip}`;
    },
  });

  // preHandler (not onRequest) so the auth plugin has already hydrated
  // req.session and Fastify has parsed req.body. Both are read by the
  // keyGenerators above.
  app.addHook(
    'preHandler',
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (isExempt(req)) return;

      const globalResult = await checkGlobal(req);
      if (!globalResult.isAllowed && globalResult.isExceeded) {
        await sendRateLimited(reply, globalResult.ttlInSeconds);
        return reply;
      }

      if (isMagicLinkSendRoute(req)) {
        const magicResult = await checkMagicLink(req);
        if (!magicResult.isAllowed && magicResult.isExceeded) {
          await sendRateLimited(reply, magicResult.ttlInSeconds);
          return reply;
        }
      }
    },
  );
}
