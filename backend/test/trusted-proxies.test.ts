import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TRUSTED_PROXIES } from '../src/plugins/trusted-proxies.ts';

const FLY_PROXY_V4 = '172.16.0.5';
const FLY_PROXY_V6 = 'fdaa:0:1::3';
const CLOUDFLARE_EDGE = '173.245.48.1';
const CLIENT = '203.0.113.9';
const SPOOFED = '6.6.6.6';

describe('trusted proxies', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false, trustProxy: [...TRUSTED_PROXIES] });
    app.get('/ip', (req) => ({ ip: req.ip }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function ipFor(
    remoteAddress: string,
    forwardedFor: string,
  ): Promise<string> {
    const response = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress,
      headers: { 'x-forwarded-for': forwardedFor },
    });
    return response.json<{ ip: string }>().ip;
  }

  it('resolves the client Cloudflare saw, ignoring entries the client sent', async () => {
    expect(
      await ipFor(FLY_PROXY_V4, `${SPOOFED}, ${CLIENT}, ${CLOUDFLARE_EDGE}`),
    ).toBe(CLIENT);
  });

  it('resolves the address Fly saw when a request skips Cloudflare', async () => {
    expect(await ipFor(FLY_PROXY_V6, `${SPOOFED}, ${CLIENT}`)).toBe(CLIENT);
  });

  it('ignores X-Forwarded-For from an untrusted peer', async () => {
    expect(await ipFor(CLIENT, SPOOFED)).toBe(CLIENT);
  });
});
