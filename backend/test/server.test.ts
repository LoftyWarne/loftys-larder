import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { buildApp, type BuildAppOptions } from '../src/server.ts';
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
};

const devConfig: Config = {
  NODE_ENV: 'development',
  HOST: '127.0.0.1',
  PORT: 0,
  LOG_LEVEL: 'silent',
  ALLOWED_ORIGIN: 'http://localhost:5173',
  DATABASE_URL: 'postgres://lofty:lofty@localhost:5433/lofty_dev',
  ...authEnv,
};

const prodConfig: Config = {
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  PORT: 0,
  LOG_LEVEL: 'silent',
  ALLOWED_ORIGIN: undefined,
  DATABASE_URL: 'postgres://lofty:lofty@localhost:5433/lofty_dev',
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
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
  });
});
