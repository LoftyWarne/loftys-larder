import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';

import { eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { initTRPC, TRPCError } from '@trpc/server';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Config } from '../src/config.ts';
import * as schema from '../src/db/schema/index.ts';
import {
  accounts,
  sessions,
  users,
  verifications,
} from '../src/db/schema/auth.ts';
import { rateLimitHits } from '../src/db/schema/rate-limits.ts';
import { protectedProcedure } from '../src/trpc/init.ts';
import type { AppContext } from '../src/trpc/context.ts';

const testT = initTRPC.context<AppContext>().create();
const probeRouter = testT.router({
  whoami: protectedProcedure.query(({ ctx }) => ({
    userId: ctx.user.id,
    sessionId: ctx.session.id,
  })),
});
const createProbeCaller = testT.createCallerFactory(probeRouter);
import { buildApp, type BuildAppOptions } from '../src/server.ts';
import { createAuth } from '../src/auth/index.ts';
import type { SignInCodeSender } from '../src/auth/resend.ts';
import {
  startTestDb,
  stopTestDb,
  TESTCONTAINER_BOOT_MS,
  type TestDb,
} from './helpers/test-db.ts';
import { contextDeps } from './helpers/context-deps.ts';

type Schema = typeof schema;

const ALLOWED_EMAIL = 'allowed@example.com';
const BLOCKED_EMAIL = 'stranger@example.com';

interface SentCode {
  to: string;
  code: string;
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: 0,
    LOG_LEVEL: 'silent',
    ALLOWED_ORIGIN: 'http://localhost:5173',
    DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
    BETTER_AUTH_SECRET: 'test-secret-thirty-two-characters-long!',
    BETTER_AUTH_URL: 'http://localhost:3000',
    RESEND_API_KEY: 're_test_key',
    MAGIC_LINK_FROM: 'magic@loftys-larder.co.uk',
    MAGIC_LINK_TRUSTED_ORIGIN: 'http://localhost:5173',
    MAGIC_LINK_ALLOWED_EMAILS: [ALLOWED_EMAIL],
    CLOUDINARY_CLOUD_NAME: 'test-cloud',
    CLOUDINARY_API_KEY: 'test-key',
    CLOUDINARY_API_SECRET: 'test-secret',
    AXIOM_ENDPOINT: 'https://api.axiom.co',
    // Stubbed for the NODE_ENV=production cases below — the logger refuses
    // to boot in prod without these (`src/plugins/logger.ts`). Real Axiom
    // ingest is opt-in by passing `fetchImpl` through `BuildAppOptions`.
    AXIOM_TOKEN: 'test-axiom-token',
    AXIOM_DATASET: 'test-axiom-dataset',
    SENTRY_TRACES_SAMPLE_RATE: 0,
    RECIPE_IMPORT_ADAPTER: 'fake',
    RECIPE_IMPORT_MODEL: 'claude-opus-5-5',
    RECIPE_IMPORT_EFFORT: 'medium',
    HEALTH_SCORE_ADAPTER: 'fake',
    HEALTH_SCORE_MODEL: 'claude-opus-5-5',
    HEALTH_SCORE_EFFORT: 'low',
    HEALTH_SCORE_SINCE: '2026-10-07',
    ...overrides,
  };
}

function encodeTrpcInput(input: unknown): string {
  return encodeURIComponent(JSON.stringify(input));
}

function parseSetCookies(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function cookieHeaderFrom(raw: string | string[] | undefined): string {
  return parseSetCookies(raw)
    .map((c) => c.split(';')[0] ?? '')
    .filter((c) => c.length > 0)
    .join('; ');
}

describe('auth', () => {
  let testDb: TestDb | undefined;
  let db!: NodePgDatabase<Schema>;
  let sent: SentCode[] = [];

  const spySender: SignInCodeSender = ({ to, code }) => {
    sent.push({ to, code });
    return Promise.resolve();
  };

  beforeAll(async () => {
    testDb = await startTestDb({ poolMax: 4 });
    db = testDb.db;
  }, TESTCONTAINER_BOOT_MS);

  afterAll(async () => {
    await stopTestDb(testDb);
  });

  beforeEach(async () => {
    sent = [];
    await db.execute(sql`
      truncate table ${users}, ${sessions}, ${accounts}, ${verifications},
        ${rateLimitHits}
      restart identity cascade
    `);
  });

  async function build(
    overrides: Partial<Config> = {},
    options: Partial<BuildAppOptions> = {},
  ): Promise<FastifyInstance> {
    return buildApp(makeConfig(overrides), {
      db,
      sendSignInCode: spySender,
      ...options,
    });
  }

  async function requestCode(
    app: FastifyInstance,
    email: string,
  ): Promise<string | undefined> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/email-otp/send-verification-otp',
      headers: { 'content-type': 'application/json' },
      payload: { email, type: 'sign-in' },
    });
    expect(response.statusCode).toBe(200);
    return sent.at(-1)?.code;
  }

  async function submitCode(
    app: FastifyInstance,
    email: string,
    otp: string,
  ): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> {
    return app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email-otp',
      headers: { 'content-type': 'application/json' },
      payload: { email, otp },
    });
  }

  async function signIn(
    app: FastifyInstance,
  ): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> {
    const code = await requestCode(app, ALLOWED_EMAIL);
    if (!code) throw new Error('expected a sign-in code send');
    return submitCode(app, ALLOWED_EMAIL, code);
  }

  function wrongCode(code: string): string {
    return code === '00000000' ? '11111111' : '00000000';
  }

  describe('sign-in code send', () => {
    it('stores a hashed code with a 10-minute expiry and sends 8 digits', async () => {
      const app = await build();
      try {
        const code = await requestCode(app, ALLOWED_EMAIL);

        expect(sent).toHaveLength(1);
        expect(sent[0]?.to).toBe(ALLOWED_EMAIL);
        expect(code).toMatch(/^\d{8}$/);

        const rows = await db.select().from(verifications);
        expect(rows).toHaveLength(1);
        const row = rows[0];
        expect(row).toBeDefined();
        if (!row || !code) return;
        expect(row.identifier).toBe(`sign-in-otp-${ALLOWED_EMAIL}`);
        expect(row.value).not.toContain(code);
        const ttlSeconds = (row.expiresAt.getTime() - Date.now()) / 1000;
        expect(ttlSeconds).toBeGreaterThan(9 * 60);
        expect(ttlSeconds).toBeLessThan(11 * 60);
      } finally {
        await app.close();
      }
    });

    it('drops requests for non-allow-listed emails without sending or storing a code', async () => {
      const app = await build();
      try {
        await requestCode(app, BLOCKED_EMAIL);
        expect(sent).toHaveLength(0);
        expect(await db.select().from(verifications)).toHaveLength(0);
      } finally {
        await app.close();
      }
    });

    it('skips the email when a fixed code is set', async () => {
      const app = await build(
        { SIGN_IN_CODE_FIXED: '42424242' },
        { sendSignInCode: undefined },
      );
      try {
        await requestCode(app, ALLOWED_EMAIL);
        expect(sent).toHaveLength(0);
        const response = await submitCode(app, ALLOWED_EMAIL, '42424242');
        expect(response.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it('sends the configured fixed code when one is set', async () => {
      const app = await build({ SIGN_IN_CODE_FIXED: '42424242' });
      try {
        expect(await requestCode(app, ALLOWED_EMAIL)).toBe('42424242');
      } finally {
        await app.close();
      }
    });
  });

  describe('sign-in code verify', () => {
    it('creates a session and sets HttpOnly SameSite=Lax cookie on the right code', async () => {
      const app = await build();
      try {
        const response = await signIn(app);
        expect(response.statusCode).toBe(200);

        const cookies = parseSetCookies(response.headers['set-cookie']);
        const sessionCookie = cookies.find((c) => c.includes('session_token'));
        expect(sessionCookie).toBeDefined();
        expect(sessionCookie).toMatch(/HttpOnly/i);
        expect(sessionCookie).toMatch(/SameSite=Lax/i);

        const sessionRows = await db.select().from(sessions);
        expect(sessionRows).toHaveLength(1);
      } finally {
        await app.close();
      }
    });

    it('rejects an expired code without creating a session', async () => {
      const app = await build();
      try {
        const code = await requestCode(app, ALLOWED_EMAIL);
        if (!code) throw new Error('expected a sign-in code send');
        await db
          .update(verifications)
          .set({ expiresAt: new Date(Date.now() - 60_000) });

        const response = await submitCode(app, ALLOWED_EMAIL, code);
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
        const sessionRows = await db.select().from(sessions);
        expect(sessionRows).toHaveLength(0);
      } finally {
        await app.close();
      }
    });

    it('rejects a reused code after the first successful sign-in', async () => {
      const app = await build();
      try {
        const code = await requestCode(app, ALLOWED_EMAIL);
        if (!code) throw new Error('expected a sign-in code send');
        const first = await submitCode(app, ALLOWED_EMAIL, code);
        expect(first.statusCode).toBe(200);

        const second = await submitCode(app, ALLOWED_EMAIL, code);
        expect(second.statusCode).toBeGreaterThanOrEqual(400);

        const sessionRows = await db.select().from(sessions);
        expect(sessionRows).toHaveLength(1);
      } finally {
        await app.close();
      }
    });

    it('only accepts the latest code after a resend', async () => {
      const app = await build();
      try {
        const first = await requestCode(app, ALLOWED_EMAIL);
        const second = await requestCode(app, ALLOWED_EMAIL);
        if (!first || !second) throw new Error('expected two code sends');
        if (first !== second) {
          const stale = await submitCode(app, ALLOWED_EMAIL, first);
          expect(stale.statusCode).toBeGreaterThanOrEqual(400);
        }
        const latest = await submitCode(app, ALLOWED_EMAIL, second);
        expect(latest.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it('locks the code after three wrong attempts', async () => {
      const app = await build();
      try {
        const code = await requestCode(app, ALLOWED_EMAIL);
        if (!code) throw new Error('expected a sign-in code send');
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const wrong = await submitCode(app, ALLOWED_EMAIL, wrongCode(code));
          expect(wrong.statusCode).toBeGreaterThanOrEqual(400);
        }

        const right = await submitCode(app, ALLOWED_EMAIL, code);
        expect(right.statusCode).toBeGreaterThanOrEqual(400);
        const sessionRows = await db.select().from(sessions);
        expect(sessionRows).toHaveLength(0);
      } finally {
        await app.close();
      }
    });
  });

  describe('allow-list', () => {
    it('does not sign up a non-allow-listed email that enters the right code', async () => {
      const app = await build({ SIGN_IN_CODE_FIXED: '42424242' });
      try {
        await requestCode(app, BLOCKED_EMAIL);
        const response = await submitCode(app, BLOCKED_EMAIL, '42424242');
        expect(response.statusCode).toBe(400);
        expect(response.json<{ code: string }>().code).toBe('INVALID_OTP');
        expect(await db.select().from(users)).toHaveLength(0);
        expect(await db.select().from(sessions)).toHaveLength(0);
      } finally {
        await app.close();
      }
    });

    it('refuses to create a non-allow-listed user even past the Fastify gate', async () => {
      const auth = createAuth({
        config: makeConfig({ SIGN_IN_CODE_FIXED: '42424242' }),
        db,
        sendSignInCode: spySender,
      });
      await auth.api.sendVerificationOTP({
        body: { email: BLOCKED_EMAIL, type: 'sign-in' },
      });

      await expect(
        auth.api.signInEmailOTP({
          body: { email: BLOCKED_EMAIL, otp: '42424242' },
        }),
      ).rejects.toMatchObject({ body: { code: 'INVALID_OTP' } });
      expect(await db.select().from(users)).toHaveLength(0);
      expect(await db.select().from(sessions)).toHaveLength(0);
    });
  });

  describe('sign-in limits', () => {
    it('stops the 6th code request for an email in an hour before Better Auth sends it', async () => {
      const app = await build();
      try {
        for (let i = 0; i < 5; i += 1) await requestCode(app, ALLOWED_EMAIL);
        const blocked = await app.inject({
          method: 'POST',
          url: '/api/auth/email-otp/send-verification-otp',
          headers: { 'content-type': 'application/json' },
          payload: { email: ALLOWED_EMAIL, type: 'sign-in' },
        });
        expect(blocked.statusCode).toBe(429);
        expect(sent).toHaveLength(5);
      } finally {
        await app.close();
      }
    });
  });

  describe('path spellings', () => {
    // A real socket, so nothing between the client and Fastify tidies the
    // path the way `new URL` does when the request is forwarded.
    function rawPost(
      port: number,
      path: string,
      body: unknown,
    ): Promise<number> {
      return new Promise((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            path,
            method: 'POST',
            headers: { 'content-type': 'application/json' },
          },
          (res) => {
            res.resume();
            res.on('end', () => {
              resolve(res.statusCode ?? 0);
            });
          },
        );
        req.on('error', reject);
        req.end(JSON.stringify(body));
      });
    }

    it.each([
      '/api/auth/./email-otp/send-verification-otp',
      '/api/auth/email-otp/./send-verification-otp',
      '/api/auth/email-otp\\send-verification-otp',
      '/api/auth/%2e/email-otp/send-verification-otp',
      '/api/auth/email-otp/../email-otp/send-verification-otp',
      '/api/auth//email-otp/send-verification-otp',
      '/api/auth/email-otp/send-verification-otp/',
      '/api/auth/email-otp/%73end-verification-otp',
    ])(
      '404s a code send to %s without sending or storing anything',
      async (path) => {
        const app = await build();
        try {
          await app.listen({ port: 0, host: '127.0.0.1' });
          const { port } = app.server.address() as AddressInfo;
          const status = await rawPost(port, path, {
            email: ALLOWED_EMAIL,
            type: 'sign-in',
          });
          expect(status).toBe(404);
          expect(sent).toHaveLength(0);
          expect(await db.select().from(verifications)).toHaveLength(0);
          expect(await db.select().from(rateLimitHits)).toHaveLength(0);
        } finally {
          await app.close();
        }
      },
    );

    it.each([
      '/api/auth/./sign-in/email-otp',
      '/api/auth/sign-in\\email-otp',
      '/api/auth/./email-otp/check-verification-otp',
      '/api/auth/./forget-password/email-otp',
    ])('404s %s', async (path) => {
      const app = await build({ SIGN_IN_CODE_FIXED: '42424242' });
      try {
        await requestCode(app, ALLOWED_EMAIL);
        await app.listen({ port: 0, host: '127.0.0.1' });
        const { port } = app.server.address() as AddressInfo;
        const status = await rawPost(port, path, {
          email: ALLOWED_EMAIL,
          otp: '42424242',
          type: 'sign-in',
        });
        expect(status).toBe(404);
        expect(await db.select().from(sessions)).toHaveLength(0);
      } finally {
        await app.close();
      }
    });
  });

  describe('unused email-OTP routes', () => {
    // Called on Better Auth directly, so this holds even if the Fastify
    // route's own block were removed.
    it.each([
      'email-otp/check-verification-otp',
      'email-otp/verify-email',
      'email-otp/request-password-reset',
      'email-otp/reset-password',
      'email-otp/request-email-change',
      'email-otp/change-email',
      'forget-password/email-otp',
    ])('Better Auth itself refuses %s', async (route) => {
      const auth = createAuth({
        config: makeConfig(),
        db,
        sendSignInCode: spySender,
      });
      const response = await auth.handler(
        new Request(`http://localhost:3000/api/auth/${route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: ALLOWED_EMAIL,
            type: 'sign-in',
            otp: '00000000',
          }),
        }),
      );
      expect(response.status).toBe(404);
    });

    it('Better Auth still serves the sign-in code route', async () => {
      const auth = createAuth({
        config: makeConfig(),
        db,
        sendSignInCode: spySender,
      });
      const response = await auth.handler(
        new Request(
          'http://localhost:3000/api/auth/email-otp/send-verification-otp',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: ALLOWED_EMAIL, type: 'sign-in' }),
          },
        ),
      );
      expect(response.status).toBe(200);
      expect(sent).toHaveLength(1);
    });

    it.each([
      '/api/auth/email-otp/check-verification-otp',
      '/api/auth/email-otp/verify-email',
      '/api/auth/email-otp/request-password-reset',
      '/api/auth/email-otp/reset-password',
      '/api/auth/forget-password/email-otp',
    ])('404s %s', async (url) => {
      const app = await build();
      try {
        const response = await app.inject({
          method: 'POST',
          url,
          headers: { 'content-type': 'application/json' },
          payload: { email: ALLOWED_EMAIL, type: 'sign-in', otp: '00000000' },
        });
        expect(response.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('refuses to send a code for a non-sign-in type', async () => {
      const app = await build();
      try {
        await signIn(app);
        sent = [];
        await db.delete(verifications);
        const response = await app.inject({
          method: 'POST',
          url: '/api/auth/email-otp/send-verification-otp',
          headers: { 'content-type': 'application/json' },
          payload: { email: ALLOWED_EMAIL, type: 'email-verification' },
        });
        expect(response.statusCode).toBe(400);
        expect(sent).toHaveLength(0);
        expect(await db.select().from(verifications)).toHaveLength(0);
      } finally {
        await app.close();
      }
    });
  });

  describe('cookie security in production', () => {
    it('sets Secure on the session cookie when NODE_ENV=production', async () => {
      const app = await build({
        NODE_ENV: 'production',
        ALLOWED_ORIGIN: undefined,
      });
      try {
        const response = await signIn(app);

        const cookies = parseSetCookies(response.headers['set-cookie']);
        const sessionCookie = cookies.find((c) => c.includes('session_token'));
        expect(sessionCookie).toBeDefined();
        expect(sessionCookie).toMatch(/Secure/);
      } finally {
        await app.close();
      }
    });
  });

  describe('pre-handler', () => {
    it('lets /api/auth/* through without a session', async () => {
      const app = await build();
      try {
        const response = await app.inject({
          method: 'GET',
          url: '/api/auth/get-session',
        });
        expect(response.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it('returns 401 for /api/trpc/health.ping in production without a session', async () => {
      const app = await build({
        NODE_ENV: 'production',
        ALLOWED_ORIGIN: undefined,
      });
      try {
        const response = await app.inject({
          method: 'GET',
          url: `/api/trpc/health.ping?input=${encodeTrpcInput({})}`,
        });
        expect(response.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('exempts /api/trpc/health.ping in dev without a session', async () => {
      const app = await build();
      try {
        const response = await app.inject({
          method: 'GET',
          url: `/api/trpc/health.ping?input=${encodeTrpcInput({})}`,
        });
        expect(response.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it('exempts non-/api GETs so the SPA shell loads without a session', async () => {
      // FEAT-05's bundled prod backend serves the SPA via @fastify/static at
      // `/`. The auth pre-handler must let the shell + assets through; the
      // SPA routes the user to /sign-in client-side. Without this exemption
      // the prod backend 401s every browser request before the SPA can hand
      // them over to Better Auth.
      const app = await build({
        NODE_ENV: 'production',
        ALLOWED_ORIGIN: undefined,
      });
      try {
        for (const url of ['/', '/sign-in', '/assets/index.js']) {
          const response = await app.inject({ method: 'GET', url });
          expect(response.statusCode).not.toBe(401);
        }
        // Cross-check: a POST to a non-/api path still 401s (it's not a
        // static-asset shape).
        const post = await app.inject({ method: 'POST', url: '/sign-in' });
        expect(post.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('admits authenticated requests through to the tRPC layer', async () => {
      const app = await build({
        NODE_ENV: 'production',
        ALLOWED_ORIGIN: undefined,
      });
      try {
        const verify = await signIn(app);
        const cookieHeader = cookieHeaderFrom(verify.headers['set-cookie']);

        const probe = await app.inject({
          method: 'GET',
          url: `/api/trpc/health.ping?input=${encodeTrpcInput({})}`,
          headers: { cookie: cookieHeader },
        });
        expect(probe.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });
  });

  describe('protectedProcedure', () => {
    it('throws UNAUTHORIZED when the context has no session', async () => {
      const caller = createProbeCaller({
        req: {} as AppContext['req'],
        reply: {} as AppContext['reply'],
        reqId: 'rid',
        ...contextDeps(),
        db: {} as AppContext['db'],
        cloudinary: {
          cloudName: 'test-cloud',
          apiKey: 'test-key',
          apiSecret: 'test-secret',
        },
        session: null,
        user: null,
      });

      await expect(caller.whoami()).rejects.toThrowError(TRPCError);
      await expect(caller.whoami()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('user provisioning', () => {
    it('creates exactly one users row across multiple sign-ins for the same email', async () => {
      const app = await build();
      try {
        expect((await signIn(app)).statusCode).toBe(200);
        expect((await signIn(app)).statusCode).toBe(200);

        const userRows = await db
          .select()
          .from(users)
          .where(eq(users.email, ALLOWED_EMAIL));
        expect(userRows).toHaveLength(1);
      } finally {
        await app.close();
      }
    });
  });
});
