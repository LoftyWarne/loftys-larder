import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { initTRPC, TRPCError } from '@trpc/server';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Config } from '../src/config.ts';
import * as schema from '../src/db/schema/index.ts';
import {
  accounts,
  sessions,
  users,
  verifications,
} from '../src/db/schema/auth.ts';
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
import type { MagicLinkSender } from '../src/auth/resend.ts';

type Schema = typeof schema;

const TESTCONTAINER_BOOT_MS = 120_000;
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'drizzle',
);

const ALLOWED_EMAIL = 'allowed@example.com';
const BLOCKED_EMAIL = 'stranger@example.com';

interface SentLink {
  to: string;
  url: string;
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

function extractTokenFromUrl(url: string): string {
  const parsed = new URL(url);
  const token = parsed.searchParams.get('token');
  if (!token) throw new Error(`no token in magic-link URL: ${url}`);
  return token;
}

describe('auth', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: pg.Pool | undefined;
  let db!: NodePgDatabase<Schema>;
  let sent: SentLink[] = [];

  const spySender: MagicLinkSender = ({ to, url }) => {
    sent.push({ to, url });
    return Promise.resolve();
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17.2-alpine').start();
    pool = new pg.Pool({
      connectionString: container.getConnectionUri(),
      max: 4,
    });
    db = drizzle(pool, { schema, casing: 'snake_case' });
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  }, TESTCONTAINER_BOOT_MS);

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  beforeEach(async () => {
    sent = [];
    await db.execute(sql`
      truncate table ${users}, ${sessions}, ${accounts}, ${verifications}
      restart identity cascade
    `);
  });

  async function build(
    overrides: Partial<Config> = {},
    options: Partial<BuildAppOptions> = {},
  ): Promise<FastifyInstance> {
    return buildApp(makeConfig(overrides), {
      db,
      sendMagicLink: spySender,
      ...options,
    });
  }

  async function requestMagicLink(
    app: FastifyInstance,
    email: string,
  ): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/magic-link',
      headers: { 'content-type': 'application/json' },
      payload: { email, callbackURL: '/' },
    });
    expect(response.statusCode).toBe(200);
  }

  describe('magic-link send', () => {
    it('creates a verification row and calls the sender', async () => {
      const app = await build();
      try {
        await requestMagicLink(app, ALLOWED_EMAIL);

        expect(sent).toHaveLength(1);
        expect(sent[0]?.to).toBe(ALLOWED_EMAIL);
        expect(sent[0]?.url).toContain('token=');

        const rows = await db.select().from(verifications);
        expect(rows).toHaveLength(1);
        const row = rows[0];
        expect(row).toBeDefined();
        if (!row) return;
        const ttlSeconds = (row.expiresAt.getTime() - Date.now()) / 1000;
        expect(ttlSeconds).toBeGreaterThan(9 * 60);
        expect(ttlSeconds).toBeLessThan(11 * 60);
      } finally {
        await app.close();
      }
    });

    it('drops requests for non-allow-listed emails without sending', async () => {
      const app = await build();
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/api/auth/sign-in/magic-link',
          headers: { 'content-type': 'application/json' },
          payload: { email: BLOCKED_EMAIL, callbackURL: '/' },
        });
        expect(response.statusCode).toBe(200);
        expect(sent).toHaveLength(0);
      } finally {
        await app.close();
      }
    });
  });

  describe('magic-link verify', () => {
    async function getToken(app: FastifyInstance): Promise<string> {
      await requestMagicLink(app, ALLOWED_EMAIL);
      const url = sent.at(-1)?.url;
      if (!url) throw new Error('no magic link captured');
      return extractTokenFromUrl(url);
    }

    it('creates a session and sets HttpOnly SameSite=Lax cookie on valid token', async () => {
      const app = await build();
      try {
        const token = await getToken(app);
        const response = await app.inject({
          method: 'GET',
          url: `/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
        });
        expect([200, 302]).toContain(response.statusCode);

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

    it('rejects an expired token without creating a session', async () => {
      const app = await build();
      try {
        const token = await getToken(app);
        await db
          .update(verifications)
          .set({ expiresAt: new Date(Date.now() - 60_000) });

        const response = await app.inject({
          method: 'GET',
          url: `/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
        });
        expect(response.statusCode).not.toBe(200);
        const sessionRows = await db.select().from(sessions);
        expect(sessionRows).toHaveLength(0);
      } finally {
        await app.close();
      }
    });

    it('rejects a reused token after first successful verify', async () => {
      const app = await build();
      try {
        const token = await getToken(app);
        const first = await app.inject({
          method: 'GET',
          url: `/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
        });
        expect([200, 302]).toContain(first.statusCode);

        const second = await app.inject({
          method: 'GET',
          url: `/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
        });

        // Better Auth signals reuse via either a 4xx body or a 302 redirect
        // to the callback URL with an `error` query param. The semantic check
        // is "no second session minted".
        if (second.statusCode === 302) {
          const location = second.headers.location;
          expect(typeof location).toBe('string');
          expect(String(location)).toMatch(/[?&]error/);
        } else {
          expect(second.statusCode).toBeGreaterThanOrEqual(400);
        }

        const sessionRows = await db.select().from(sessions);
        expect(sessionRows).toHaveLength(1);
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
        await requestMagicLink(app, ALLOWED_EMAIL);
        const first = sent[0];
        if (!first) throw new Error('expected magic-link send');
        const token = extractTokenFromUrl(first.url);
        const response = await app.inject({
          method: 'GET',
          url: `/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
        });

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

    it('admits authenticated requests through to the tRPC layer', async () => {
      const app = await build({
        NODE_ENV: 'production',
        ALLOWED_ORIGIN: undefined,
      });
      try {
        await requestMagicLink(app, ALLOWED_EMAIL);
        const first = sent[0];
        if (!first) throw new Error('expected magic-link send');
        const token = extractTokenFromUrl(first.url);
        const verify = await app.inject({
          method: 'GET',
          url: `/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
        });
        const cookies = parseSetCookies(verify.headers['set-cookie']);
        const cookieHeader = cookies
          .map((c) => c.split(';')[0] ?? '')
          .filter((c) => c.length > 0)
          .join('; ');

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
        await requestMagicLink(app, ALLOWED_EMAIL);
        const latestA = sent.at(-1);
        if (!latestA) throw new Error('expected magic-link send');
        const tokenA = extractTokenFromUrl(latestA.url);
        await app.inject({
          method: 'GET',
          url: `/api/auth/magic-link/verify?token=${encodeURIComponent(tokenA)}`,
        });

        await requestMagicLink(app, ALLOWED_EMAIL);
        const latestB = sent.at(-1);
        if (!latestB) throw new Error('expected magic-link send');
        const tokenB = extractTokenFromUrl(latestB.url);
        await app.inject({
          method: 'GET',
          url: `/api/auth/magic-link/verify?token=${encodeURIComponent(tokenB)}`,
        });

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
