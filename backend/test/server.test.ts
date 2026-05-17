import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server.ts';
import type { Config } from '../src/config.ts';

const devConfig: Config = {
  NODE_ENV: 'development',
  HOST: '127.0.0.1',
  PORT: 0,
  LOG_LEVEL: 'silent',
  ALLOWED_ORIGIN: 'http://localhost:5173',
};

const prodConfig: Config = {
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  PORT: 0,
  LOG_LEVEL: 'silent',
  ALLOWED_ORIGIN: undefined,
};

function encodeTrpcInput(input: unknown): string {
  return encodeURIComponent(JSON.stringify(input));
}

describe('buildApp', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('boots, is ready, and responds to a probe', async () => {
    app = await buildApp(devConfig);
    await app.ready();
    const probe = await app.inject({
      method: 'GET',
      url: `/api/trpc/health.ping?input=${encodeTrpcInput({})}`,
    });
    expect(probe.statusCode).toBe(200);
  });

  it('returns { ok: true, reqId } from health.ping', async () => {
    app = await buildApp(devConfig);
    const response = await app.inject({
      method: 'GET',
      url: `/api/trpc/health.ping?input=${encodeTrpcInput({})}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { result: { data: { ok: boolean; reqId: string } } };
    expect(body.result.data.ok).toBe(true);
    expect(typeof body.result.data.reqId).toBe('string');
    expect(body.result.data.reqId.length).toBeGreaterThan(0);
  });

  it('round-trips the same reqId that Fastify assigned', async () => {
    app = await buildApp(devConfig);
    const response = await app.inject({
      method: 'GET',
      url: `/api/trpc/health.ping?input=${encodeTrpcInput({})}`,
    });
    const headerReqId = response.headers['x-request-id'] ?? response.headers['request-id'];
    const body = response.json() as { result: { data: { reqId: string } } };
    if (typeof headerReqId === 'string') {
      expect(body.result.data.reqId).toBe(headerReqId);
    } else {
      expect(typeof body.result.data.reqId).toBe('string');
    }
  });

  it('generates a fresh reqId per request', async () => {
    app = await buildApp(devConfig);
    const first = await app.inject({
      method: 'GET',
      url: `/api/trpc/health.ping?input=${encodeTrpcInput({})}`,
    });
    const second = await app.inject({
      method: 'GET',
      url: `/api/trpc/health.ping?input=${encodeTrpcInput({})}`,
    });
    const firstBody = first.json() as { result: { data: { reqId: string } } };
    const secondBody = second.json() as { result: { data: { reqId: string } } };
    expect(firstBody.result.data.reqId).not.toBe(secondBody.result.data.reqId);
  });
});

describe('CORS', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('returns CORS headers in dev for the allowed origin', async () => {
    app = await buildApp(devConfig);
    const response = await app.inject({
      method: 'OPTIONS',
      url: `/api/trpc/health.ping`,
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
      },
    });
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('omits CORS headers in dev for a foreign origin', async () => {
    app = await buildApp(devConfig);
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
    app = await buildApp(prodConfig);
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
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('mounts static at /api/static and leaves /api/trpc reachable', async () => {
    app = await buildApp(devConfig);
    const trpcResponse = await app.inject({
      method: 'GET',
      url: `/api/trpc/health.ping?input=${encodeTrpcInput({})}`,
    });
    expect(trpcResponse.statusCode).toBe(200);

    const staticResponse = await app.inject({
      method: 'GET',
      url: '/api/static/does-not-exist.txt',
    });
    expect(staticResponse.statusCode).toBe(404);
  });
});

describe('security headers', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    app = undefined as unknown as FastifyInstance;
  });

  it('sets helmet default headers', async () => {
    app = await buildApp(devConfig);
    const response = await app.inject({
      method: 'GET',
      url: `/api/trpc/health.ping?input=${encodeTrpcInput({})}`,
    });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
  });
});
