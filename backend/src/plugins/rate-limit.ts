import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const RATE_LIMITED_CODE = 'RATE_LIMITED';

interface RateLimitedBody {
  error: 'TooManyRequests';
  code: typeof RATE_LIMITED_CODE;
  retryAfterSeconds: number;
}

function isExempt(req: FastifyRequest): boolean {
  // Fly hits /api/health every few seconds for liveness; counting those
  // toward the IP bucket would 429 the platform's probes.
  return req.url.startsWith('/api/health');
}

export async function sendRateLimited(
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
  importStartsPerHour?: number;
  healthScoresPerHour?: number;
}

export interface ModelRateLimitVerdict {
  allowed: boolean;
  retryAfterSeconds: number;
}

declare module 'fastify' {
  interface FastifyInstance {
    // Counts one Recipe Import `start` for the request's user.
    limitRecipeImportStart: (
      req: FastifyRequest,
    ) => Promise<ModelRateLimitVerdict>;
    // Counts one `healthScores.score` that reaches the model for the
    // request's user.
    limitHealthScore: (req: FastifyRequest) => Promise<ModelRateLimitVerdict>;
  }
}

type RateLimitResult = Awaited<
  ReturnType<ReturnType<FastifyInstance['createRateLimit']>>
>;

function toVerdict(result: RateLimitResult): ModelRateLimitVerdict {
  // `isAllowed` means allow-listed; under the limit is `!isExceeded`.
  if (result.isAllowed || !result.isExceeded) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  return { allowed: false, retryAfterSeconds: result.ttlInSeconds };
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

  // Each import calls a paid model (DEC-104): every `start` counts, per user.
  // Checked inside the procedure rather than here, so the refusal is a tRPC
  // error the Import page can show.
  const checkImportStart = app.createRateLimit({
    max: options.importStartsPerHour ?? 14,
    timeWindow: '1 hour',
    keyGenerator: (req) =>
      req.user ? `import:${req.user.id}` : `import-ip:${req.ip}`,
  });
  app.decorate('limitRecipeImportStart', async (req: FastifyRequest) =>
    toVerdict(await checkImportStart(req)),
  );

  // Each score calls a paid model too (DEC-112): every call that gets past
  // the cheap checks counts, bulk runs included.
  const checkHealthScore = app.createRateLimit({
    max: options.healthScoresPerHour ?? 30,
    timeWindow: '1 hour',
    keyGenerator: (req) =>
      req.user ? `health-score:${req.user.id}` : `health-score-ip:${req.ip}`,
  });
  app.decorate('limitHealthScore', async (req: FastifyRequest) =>
    toVerdict(await checkHealthScore(req)),
  );

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
    },
  );
}
