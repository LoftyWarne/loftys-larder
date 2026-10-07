import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { registerRateLimit } from '../src/plugins/rate-limit.ts';
// Side-effect import: pulls in the `req.session` / `req.user` module
// augmentation declared in trpc/context.ts so the rate-limit plugin's
// `req.session?.id` access typechecks here too.
import type {} from '../src/trpc/context.ts';

interface SessionLike {
  id: string;
  userId: string;
}

interface BuildOptions {
  // If provided, the preHandler hook hydrates req.session before the
  // rate-limit plugin's preHandler runs (registration order = run order).
  sessionFromHeader?: string;
}

async function buildTestApp(
  options: BuildOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    trustProxy: true,
  });

  app.decorateRequest('session', null);
  app.decorateRequest('user', null);

  if (options.sessionFromHeader) {
    const header = options.sessionFromHeader;
    app.addHook('preHandler', (req, _reply, done) => {
      const raw = req.headers[header];
      const value = Array.isArray(raw) ? raw[0] : raw;
      if (typeof value === 'string' && value.length > 0) {
        const session: SessionLike = { id: value, userId: `user-${value}` };
        // Cast through unknown because the augmented type expects Better
        // Auth's full session shape; the rate-limit plugin only reads `id`,
        // so a structural stub is sufficient for these tests.
        req.session = session as unknown as typeof req.session;
      }
      done();
    });
  }

  await registerRateLimit(app);

  app.get('/probe', () => ({ ok: true }));
  app.get('/api/health', () => ({ ok: true }));
  app.post('/api/auth/sign-in/magic-link', () => ({ ok: true }));

  await app.ready();
  return app;
}

interface Burst {
  lastStatus: number;
}

async function burst(
  app: FastifyInstance,
  count: number,
  inject: () => InjectOptions,
): Promise<Burst> {
  let lastStatus = 0;
  for (let i = 0; i < count; i += 1) {
    const response = await app.inject(inject());
    lastStatus = response.statusCode;
  }
  return { lastStatus };
}

describe('rate limit — unauthenticated IP bucket', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it('allows 100 requests per minute then 429s the 101st', async () => {
    app = await buildTestApp();

    const allowed = await burst(app, 100, () => ({
      method: 'GET',
      url: '/probe',
      headers: { 'x-forwarded-for': '203.0.113.10' },
    }));
    expect(allowed.lastStatus).toBe(200);

    const blocked = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-forwarded-for': '203.0.113.10' },
    });
    expect(blocked.statusCode).toBe(429);

    const body = blocked.json<{
      error: string;
      code: string;
      retryAfterSeconds: number;
    }>();
    expect(body.error).toBe('TooManyRequests');
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('keeps separate buckets per forwarded IP (trust proxy honoured)', async () => {
    app = await buildTestApp();

    const first = await burst(app, 100, () => ({
      method: 'GET',
      url: '/probe',
      headers: { 'x-forwarded-for': '203.0.113.20' },
    }));
    expect(first.lastStatus).toBe(200);

    const otherIp = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-forwarded-for': '203.0.113.21' },
    });
    expect(otherIp.statusCode).toBe(200);
  });
});

describe('rate limit — authenticated session bucket', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it('allows 300 requests per minute per session then 429s the 301st', async () => {
    app = await buildTestApp({ sessionFromHeader: 'x-test-session' });

    const allowed = await burst(app, 300, () => ({
      method: 'GET',
      url: '/probe',
      headers: { 'x-test-session': 'session-a' },
    }));
    expect(allowed.lastStatus).toBe(200);

    const blocked = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-test-session': 'session-a' },
    });
    expect(blocked.statusCode).toBe(429);

    const otherSession = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-test-session': 'session-b' },
    });
    expect(otherSession.statusCode).toBe(200);
  });
});

describe('rate limit — magic-link per-email bucket', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it('allows 5 sends per email per hour and blocks the 6th', async () => {
    app = await buildTestApp();

    for (let i = 0; i < 5; i += 1) {
      const ok = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/magic-link',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '203.0.113.40',
        },
        payload: { email: 'a@example.com', callbackURL: '/' },
      });
      expect(ok.statusCode).toBe(200);
    }

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/magic-link',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.40',
      },
      payload: { email: 'a@example.com', callbackURL: '/' },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    const body = blocked.json<{
      error: string;
      code: string;
      retryAfterSeconds: number;
    }>();
    expect(body.error).toBe('TooManyRequests');
    expect(body.code).toBe('RATE_LIMITED');

    const otherEmail = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/magic-link',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.40',
      },
      payload: { email: 'b@example.com', callbackURL: '/' },
    });
    expect(otherEmail.statusCode).toBe(200);
  });

  it('normalises the email so casing and whitespace share a bucket', async () => {
    app = await buildTestApp();

    for (let i = 0; i < 5; i += 1) {
      const ok = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/magic-link',
        headers: { 'content-type': 'application/json' },
        payload: { email: 'casing@example.com' },
      });
      expect(ok.statusCode).toBe(200);
    }

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/magic-link',
      headers: { 'content-type': 'application/json' },
      payload: { email: '  CASING@example.com  ' },
    });
    expect(blocked.statusCode).toBe(429);
  });

  it('falls back to IP when the request body omits the email', async () => {
    app = await buildTestApp();

    for (let i = 0; i < 5; i += 1) {
      const ok = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/magic-link',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '203.0.113.50',
        },
        payload: { callbackURL: '/' },
      });
      expect(ok.statusCode).toBe(200);
    }

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/magic-link',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.50',
      },
      payload: { callbackURL: '/' },
    });
    expect(blocked.statusCode).toBe(429);
  });
});

describe('rate limit — exemptions and trust proxy', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it('exempts /api/health from the global limiter', async () => {
    app = await buildTestApp();

    const burst200 = await burst(app, 200, () => ({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-forwarded-for': '203.0.113.60' },
    }));
    expect(burst200.lastStatus).toBe(200);
  });

  it('respects X-Forwarded-For when assigning IP buckets', async () => {
    app = await buildTestApp();

    const first = await burst(app, 100, () => ({
      method: 'GET',
      url: '/probe',
      headers: { 'x-forwarded-for': '203.0.113.70' },
    }));
    expect(first.lastStatus).toBe(200);

    const sameSocketDifferentForwarded = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-forwarded-for': '203.0.113.71' },
    });
    expect(sameSocketDifferentForwarded.statusCode).toBe(200);

    const exhaustedForwarded = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-forwarded-for': '203.0.113.70' },
    });
    expect(exhaustedForwarded.statusCode).toBe(429);
  });
});

describe('rate limit — Recipe Import starts per user', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  async function buildImportApp(): Promise<FastifyInstance> {
    const instance = Fastify({ logger: false, trustProxy: true });
    instance.decorateRequest('session', null);
    instance.decorateRequest('user', null);
    instance.addHook('preHandler', (req, _reply, done) => {
      const raw = req.headers['x-test-user'];
      if (typeof raw === 'string') {
        // Structural stub: the import limiter only reads `user.id`.
        req.user = { id: raw } as unknown as typeof req.user;
      }
      done();
    });
    await registerRateLimit(instance);
    instance.post('/import-probe', (req) =>
      instance.limitRecipeImportStart(req),
    );
    await instance.ready();
    return instance;
  }

  async function start(instance: FastifyInstance, userId: string) {
    const response = await instance.inject({
      method: 'POST',
      url: '/import-probe',
      headers: { 'x-test-user': userId },
    });
    return response.json<{ allowed: boolean; retryAfterSeconds: number }>();
  }

  it('allows 14 starts an hour per user and refuses the 15th', async () => {
    app = await buildImportApp();
    for (let i = 0; i < 14; i += 1) {
      expect((await start(app, 'user-a')).allowed).toBe(true);
    }
    const refused = await start(app, 'user-a');
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('keeps a separate count for each user', async () => {
    app = await buildImportApp();
    for (let i = 0; i < 14; i += 1) await start(app, 'user-a');
    expect((await start(app, 'user-b')).allowed).toBe(true);
  });
});

describe('rate limit — health scores per user', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  async function buildScoreApp(): Promise<FastifyInstance> {
    const instance = Fastify({ logger: false, trustProxy: true });
    instance.decorateRequest('session', null);
    instance.decorateRequest('user', null);
    instance.addHook('preHandler', (req, _reply, done) => {
      const raw = req.headers['x-test-user'];
      if (typeof raw === 'string') {
        // Structural stub: the score limiter only reads `user.id`.
        req.user = { id: raw } as unknown as typeof req.user;
      }
      done();
    });
    await registerRateLimit(instance);
    instance.post('/score-probe', (req) => instance.limitHealthScore(req));
    await instance.ready();
    return instance;
  }

  async function score(instance: FastifyInstance, userId: string) {
    const response = await instance.inject({
      method: 'POST',
      url: '/score-probe',
      headers: { 'x-test-user': userId },
    });
    return response.json<{ allowed: boolean; retryAfterSeconds: number }>();
  }

  it('allows 30 scores an hour per user and refuses the 31st', async () => {
    app = await buildScoreApp();
    for (let i = 0; i < 30; i += 1) {
      expect((await score(app, 'user-a')).allowed).toBe(true);
    }
    const refused = await score(app, 'user-a');
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('keeps a separate count for each user', async () => {
    app = await buildScoreApp();
    for (let i = 0; i < 30; i += 1) await score(app, 'user-a');
    expect((await score(app, 'user-b')).allowed).toBe(true);
  });
});
