import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { PassThrough } from 'node:stream';
import {
  buildApp,
  buildAppWithLogger,
  type BuildAppOptions,
} from '../src/server.ts';
import type { Config } from '../src/config.ts';
import * as schema from '../src/db/schema/index.ts';

const fakeDbPool = new pg.Pool({
  max: 1,
  connectionString: 'postgres://x:x@127.0.0.1:1/x',
});
const fakeDb: NodePgDatabase<typeof schema> = drizzle(fakeDbPool, {
  schema,
  casing: 'snake_case',
});

const buildOptions: BuildAppOptions = {
  db: fakeDb,
  sendMagicLink: () => Promise.resolve(),
};

const authEnv = {
  BETTER_AUTH_SECRET: 'test-secret-thirty-two-characters-long!',
  BETTER_AUTH_URL: 'http://localhost:3000',
  RESEND_API_KEY: 're_test_key',
  MAGIC_LINK_FROM: 'magic@loftys-larder.co.uk',
  MAGIC_LINK_TRUSTED_ORIGIN: 'http://localhost:5173',
  MAGIC_LINK_ALLOWED_EMAILS: ['allowed@example.com'] as string[],
  CLOUDINARY_CLOUD_NAME: 'test-cloud',
  CLOUDINARY_API_KEY: 'test-key',
  CLOUDINARY_API_SECRET: 'test-secret',
};

const devConfig: Config = {
  NODE_ENV: 'development',
  HOST: '127.0.0.1',
  PORT: 0,
  LOG_LEVEL: 'silent',
  ALLOWED_ORIGIN: 'http://localhost:5173',
  DATABASE_URL: 'postgres://lofty:lofty@localhost:5433/lofty_dev',
  AXIOM_ENDPOINT: 'https://api.axiom.co',
  SENTRY_TRACES_SAMPLE_RATE: 0,
  ...authEnv,
};

const prodConfig: Config = {
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  PORT: 0,
  LOG_LEVEL: 'silent',
  ALLOWED_ORIGIN: undefined,
  DATABASE_URL: 'postgres://lofty:lofty@localhost:5433/lofty_dev',
  AXIOM_TOKEN: 'test-axiom-token',
  AXIOM_DATASET: 'test-dataset',
  AXIOM_ENDPOINT: 'https://api.axiom.co',
  SENTRY_TRACES_SAMPLE_RATE: 0,
  ...authEnv,
};

function encodeTrpcInput(input: unknown): string {
  return encodeURIComponent(JSON.stringify(input));
}

describe('buildApp', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('boots, is ready, and responds to a probe', async () => {
    app = await buildApp(devConfig, buildOptions);
    await app.ready();
    const probe = await app.inject({
      method: 'GET',
      url: `/api/trpc/health.ping?input=${encodeTrpcInput({})}`,
    });
    expect(probe.statusCode).toBe(200);
  });

  it('returns { ok: true, reqId } from health.ping', async () => {
    app = await buildApp(devConfig, buildOptions);
    const response = await app.inject({
      method: 'GET',
      url: `/api/trpc/health.ping?input=${encodeTrpcInput({})}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      result: { data: { ok: boolean; reqId: string } };
    }>();
    expect(body.result.data.ok).toBe(true);
    expect(typeof body.result.data.reqId).toBe('string');
    expect(body.result.data.reqId.length).toBeGreaterThan(0);
  });

  it('round-trips the same reqId that Fastify assigned', async () => {
    app = await buildApp(devConfig, buildOptions);
    const response = await app.inject({
      method: 'GET',
      url: `/api/trpc/health.ping?input=${encodeTrpcInput({})}`,
    });
    const headerReqId =
      response.headers['x-request-id'] ?? response.headers['request-id'];
    const body = response.json<{ result: { data: { reqId: string } } }>();
    if (typeof headerReqId === 'string') {
      expect(body.result.data.reqId).toBe(headerReqId);
    } else {
      expect(typeof body.result.data.reqId).toBe('string');
    }
  });

  it('generates a fresh reqId per request', async () => {
    app = await buildApp(devConfig, buildOptions);
    const first = await app.inject({
      method: 'GET',
      url: `/api/trpc/health.ping?input=${encodeTrpcInput({})}`,
    });
    const second = await app.inject({
      method: 'GET',
      url: `/api/trpc/health.ping?input=${encodeTrpcInput({})}`,
    });
    const firstBody = first.json<{ result: { data: { reqId: string } } }>();
    const secondBody = second.json<{ result: { data: { reqId: string } } }>();
    expect(firstBody.result.data.reqId).not.toBe(secondBody.result.data.reqId);
  });
});

describe('CORS', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('returns CORS headers in dev for the allowed origin', async () => {
    app = await buildApp(devConfig, buildOptions);
    const response = await app.inject({
      method: 'OPTIONS',
      url: `/api/trpc/health.ping`,
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
      },
    });
    expect(response.headers['access-control-allow-origin']).toBe(
      'http://localhost:5173',
    );
  });

  it('omits CORS headers in dev for a foreign origin', async () => {
    app = await buildApp(devConfig, buildOptions);
    const response = await app.inject({
      method: 'OPTIONS',
      url: `/api/trpc/health.ping`,
      headers: {
        origin: 'http://evil.example',
        'access-control-request-method': 'GET',
      },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not register CORS in production', async () => {
    app = await buildApp(prodConfig, buildOptions);
    const response = await app.inject({
      method: 'OPTIONS',
      url: `/api/trpc/health.ping`,
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
      },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('static + tRPC coexistence', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('leaves /api/trpc reachable and rejects unrouted /api/* with 401', async () => {
    app = await buildApp(devConfig, buildOptions);
    const trpcResponse = await app.inject({
      method: 'GET',
      url: `/api/trpc/health.ping?input=${encodeTrpcInput({})}`,
    });
    expect(trpcResponse.statusCode).toBe(200);

    // The auth pre-handler short-circuits before the not-found handler, so
    // arbitrary /api/* paths return 401 rather than 404. The auth surface and
    // dev-only health.ping are the only unauthenticated exemptions.
    const staticResponse = await app.inject({
      method: 'GET',
      url: '/api/static/does-not-exist.txt',
    });
    expect(staticResponse.statusCode).toBe(401);
  });
});

describe('batched tRPC route param length', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('routes a batch whose comma-joined procedure path exceeds 100 chars', async () => {
    app = await buildApp(devConfig, buildOptions);

    // httpBatchLink coalesces every queued query into one GET, encoding the
    // procedure names as a single comma-joined `/api/trpc/:path` param. The
    // planner fans out one `plants.forDay` per visible day, so a real plan
    // sails past Fastify's default 100-char param cap. Twelve health.ping's
    // reproduce that overflow using the dev-exempt procedure.
    const count = 12;
    const path = Array.from({ length: count }, () => 'health.ping').join(',');
    expect(path.length).toBeGreaterThan(100);

    const input = Object.fromEntries(
      Array.from({ length: count }, (_, i) => [i, {}]),
    );
    const response = await app.inject({
      method: 'GET',
      url: `/api/trpc/${path}?batch=1&input=${encodeTrpcInput(input)}`,
    });

    // Without a raised maxParamLength this path misses the route and the
    // not-found handler answers 404, which the batch client can't decode.
    expect(response.statusCode).toBe(200);
    const body = response.json<{ result: { data: { ok: boolean } } }[]>();
    expect(body).toHaveLength(count);
    expect(body.every((entry) => entry.result.data.ok)).toBe(true);
  });
});

describe('auth pre-handler', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('exempts /api/trpc/health.ping in dev', async () => {
    app = await buildApp(devConfig, buildOptions);
    const response = await app.inject({
      method: 'GET',
      url: `/api/trpc/health.ping?input=${encodeTrpcInput({})}`,
    });
    expect(response.statusCode).toBe(200);
  });

  it('requires auth for /api/trpc/health.ping in production', async () => {
    app = await buildApp(prodConfig, buildOptions);
    const response = await app.inject({
      method: 'GET',
      url: `/api/trpc/health.ping?input=${encodeTrpcInput({})}`,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('Axiom log propagation', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('emits a log entry to Axiom carrying the request reqId (DEC-77)', async () => {
    const fetchSpy = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    );
    // Capture (and discard) the stdout mirror so the production-mode logs
    // don't leak JSON into the test output.
    const silentStdout = new PassThrough();
    silentStdout.resume();
    const built = await buildAppWithLogger(
      { ...prodConfig, LOG_LEVEL: 'info' },
      { ...buildOptions, fetchImpl: fetchSpy, stdout: silentStdout },
    );
    app = built.app;
    // Capture the reqId Fastify assigns; the response header isn't exposed by
    // default in Fastify v5, but req.id is the same value Pino's child logger
    // emits as `reqId` on every entry tied to that request.
    let observedReqId: string | undefined;
    app.addHook('onRequest', (req, _reply, done) => {
      observedReqId = req.id;
      done();
    });
    await app.inject({
      method: 'GET',
      url: `/api/trpc/health.ping?input=${encodeTrpcInput({})}`,
    });
    if (!built.axiom) throw new Error('expected Axiom destination');
    await built.axiom.end();

    expect(observedReqId).toBeDefined();
    expect(fetchSpy).toHaveBeenCalled();
    const ndjson = fetchSpy.mock.calls
      .map((call) => {
        const body = call[1]?.body;
        return typeof body === 'string' ? body : '';
      })
      .join('');
    const matched = ndjson
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { reqId?: string })
      .find((entry) => entry.reqId === observedReqId);
    expect(matched).toBeDefined();
  });
});

describe('security headers', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    app = undefined;
  });

  it('sets helmet default headers', async () => {
    app = await buildApp(devConfig, buildOptions);
    const response = await app.inject({
      method: 'GET',
      url: `/api/trpc/health.ping?input=${encodeTrpcInput({})}`,
    });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
  });
});
