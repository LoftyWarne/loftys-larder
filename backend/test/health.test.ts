import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import pino, { type Level } from 'pino';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Auth } from '../src/auth/index.ts';
import type { Config } from '../src/config.ts';
import type { Db } from '../src/db/index.ts';
import { registerAuth } from '../src/plugins/auth.ts';
import { registerHealth } from '../src/routes/health.ts';
// Side-effect import: pulls in the `app.db` / `req.session` augmentations
// so casts to FastifyInstance / FastifyRequest stay typed.
import type {} from '../src/trpc/context.ts';

interface CaptureLogs {
  loggerInstance: FastifyBaseLogger;
  lines: () => Record<string, unknown>[];
}

function captureLogs(level: Level = 'warn'): CaptureLogs {
  const chunks: string[] = [];
  const stream = new PassThrough();
  stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  const loggerInstance: FastifyBaseLogger = pino({ level }, stream);
  return {
    loggerInstance,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

function stubDb(execute: () => Promise<unknown>): Db {
  return { execute } as unknown as Db;
}

function buildHealthApp(db: Db, capture?: CaptureLogs): FastifyInstance {
  // Mirrors server.ts: widening the pino Logger to FastifyBaseLogger keeps
  // Fastify's generic inference at its default base-logger so the returned
  // FastifyInstance stays assignable to the augmented shape exported from
  // trpc/context.ts.
  const baseLogger: FastifyBaseLogger | undefined = capture
    ? capture.loggerInstance
    : undefined;
  const app = Fastify(
    baseLogger ? { loggerInstance: baseLogger } : { logger: false },
  );
  app.decorate('db', db);
  registerHealth(app);
  return app;
}

describe('/api/health', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.useRealTimers();
  });

  it('returns 200 { ok: true } when the DB probe succeeds', async () => {
    app = buildHealthApp(stubDb(() => Promise.resolve({ rows: [] })));
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it('returns 503 { ok: false } when the DB probe rejects', async () => {
    app = buildHealthApp(stubDb(() => Promise.reject(new Error('boom'))));
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false });
  });

  it('returns 503 when the DB probe exceeds the 2s timeout', async () => {
    vi.useFakeTimers();
    app = buildHealthApp(stubDb(() => new Promise<never>(() => undefined)));
    const responsePromise = app.inject({
      method: 'GET',
      url: '/api/health',
    });
    await vi.advanceTimersByTimeAsync(2_000);
    const response = await responsePromise;
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false });
  });

  it('emits a single warn-level log when the probe fails', async () => {
    const capture = captureLogs('warn');
    app = buildHealthApp(
      stubDb(() => Promise.reject(new Error('boom'))),
      capture,
    );
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
    });
    expect(response.statusCode).toBe(503);
    const warnings = capture
      .lines()
      .filter((l) => l.msg === 'health probe failed');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.reason).toBe('error');
  });

  it('is exempt from the auth pre-handler', async () => {
    const fakeAuth = {
      handler: () => Promise.resolve(new Response(null, { status: 200 })),
      api: { getSession: () => Promise.resolve(null) },
    } as unknown as Auth;
    const config = {
      BETTER_AUTH_URL: 'http://localhost:3000',
      NODE_ENV: 'production',
    } as Config;
    app = buildHealthApp(stubDb(() => Promise.resolve({ rows: [] })));
    registerAuth(app, { auth: fakeAuth, config });
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
  });
});
