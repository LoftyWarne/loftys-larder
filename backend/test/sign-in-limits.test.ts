import { sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import { rateLimitHits } from '../src/db/schema/rate-limits.ts';
import {
  clientNetwork,
  countHit,
  registerSignInLimits,
} from '../src/plugins/sign-in-limits.ts';
import { TRUSTED_PROXIES } from '../src/plugins/trusted-proxies.ts';
import type {} from '../src/trpc/context.ts';
import {
  startTestDb,
  stopTestDb,
  TESTCONTAINER_BOOT_MS,
  type TestDb,
} from './helpers/test-db.ts';

const MEMBER = 'member@example.com';
const STRANGER = 'stranger@example.com';
const SEND = '/api/auth/email-otp/send-verification-otp';
const ENTER = '/api/auth/sign-in/email-otp';

describe('clientNetwork', () => {
  it.each([
    ['203.0.113.9', '203.0.113.9'],
    ['::ffff:203.0.113.9', '203.0.113.9'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:db8:1:2::9', '2001:db8:1:2::/64'],
    ['2001:0db8:0001::', '2001:db8:1:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['2001:DB8:1:2::9', '2001:db8:1:2::/64'],
    ['::1', '0:0:0:0::/64'],
    ['garbage', 'invalid'],
    ['zz::1', 'invalid'],
    ['1.2.3.4.5', 'invalid'],
    ['', 'invalid'],
  ])('%s → %s', (ip, expected) => {
    expect(clientNetwork(ip)).toBe(expected);
  });
});

describe('sign-in limits', () => {
  let testDb: TestDb | undefined;
  let app: FastifyInstance | undefined;

  beforeAll(async () => {
    testDb = await startTestDb({ poolMax: 8 });
  }, TESTCONTAINER_BOOT_MS);

  afterAll(async () => {
    await stopTestDb(testDb);
  });

  beforeEach(async () => {
    await testDb?.db.execute(sql`truncate table ${rateLimitHits}`);
  });

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  function db(): TestDb['db'] {
    if (!testDb) throw new Error('test database not started');
    return testDb.db;
  }

  async function buildApp(): Promise<FastifyInstance> {
    const instance = Fastify({
      logger: false,
      trustProxy: [...TRUSTED_PROXIES],
    });
    instance.decorate('db', db());
    registerSignInLimits(instance, { allowedEmails: [MEMBER] });
    instance.post(SEND, () => ({ ok: true }));
    instance.post(ENTER, () => ({ ok: true }));
    await instance.ready();
    app = instance;
    return instance;
  }

  function send(email: string): InjectOptions {
    return {
      method: 'POST',
      url: SEND,
      headers: { 'content-type': 'application/json' },
      payload: { email, type: 'sign-in' },
    };
  }

  function enter(email: string, ip: string): InjectOptions {
    return {
      method: 'POST',
      url: ENTER,
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      payload: { email, otp: '00000000' },
    };
  }

  async function statuses(
    instance: FastifyInstance,
    requests: InjectOptions[],
  ): Promise<number[]> {
    const responses = await Promise.all(
      requests.map((request) => instance.inject(request)),
    );
    return responses.map((response) => response.statusCode);
  }

  describe('countHit', () => {
    it('counts every concurrent hit exactly once', async () => {
      const hits = await Promise.all(
        Array.from({ length: 40 }, () => countHit(db(), 'k', 3600)),
      );
      expect(hits.map((h) => h.count).sort((a, b) => a - b)).toEqual(
        Array.from({ length: 40 }, (_, i) => i + 1),
      );
    });

    it('opens fresh windows on many expired keys at once without deadlocking', async () => {
      const keys = Array.from({ length: 16 }, (_, i) => `k${String(i)}`);
      for (let round = 0; round < 3; round += 1) {
        await Promise.all(keys.map((key) => countHit(db(), key, 3600)));
        await db()
          .update(rateLimitHits)
          .set({ resetAt: sql`now() - interval '1 second'` });
        const hits = await Promise.all(
          keys.map((key) => countHit(db(), key, 3600)),
        );
        expect(hits.map((h) => h.count)).toEqual(keys.map(() => 1));
      }
    });

    it('starts a fresh window once the old one ends, clearing expired rows', async () => {
      await countHit(db(), 'k', 3600);
      await countHit(db(), 'other', 3600);
      await db()
        .update(rateLimitHits)
        .set({ resetAt: sql`now() - interval '1 second'` });

      const hit = await countHit(db(), 'k', 3600);

      expect(hit.count).toBe(1);
      expect(hit.retryAfterSeconds).toBeGreaterThan(3590);
      const keys = await db()
        .select({ key: rateLimitHits.key })
        .from(rateLimitHits);
      expect(keys).toEqual([{ key: 'k' }]);
    });
  });

  it('allows 5 code sends per email an hour and blocks the 6th', async () => {
    const instance = await buildApp();
    const firstFive = await statuses(
      instance,
      Array.from({ length: 5 }, () => send(MEMBER)),
    );
    expect(firstFive).toEqual([200, 200, 200, 200, 200]);

    const blocked = await instance.inject(send(` ${MEMBER.toUpperCase()} `));
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json<{ code: string }>().code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('leaves non-allow-listed emails to the auth route without counting them', async () => {
    const instance = await buildApp();
    const results = await statuses(instance, [
      ...Array.from({ length: 8 }, () => send(STRANGER)),
      ...Array.from({ length: 12 }, () => enter(STRANGER, '203.0.113.9')),
    ]);
    expect(results.every((status) => status === 200)).toBe(true);
    expect(await db().select().from(rateLimitHits)).toHaveLength(0);
  });

  it('stops one client after 10 code entries without blocking another', async () => {
    const instance = await buildApp();
    const attacker = await statuses(
      instance,
      Array.from({ length: 15 }, () => enter(MEMBER, '198.51.100.7')),
    );
    expect(attacker.filter((s) => s === 200)).toHaveLength(10);
    expect(attacker.filter((s) => s === 429)).toHaveLength(5);

    const member = await instance.inject(enter(MEMBER, '203.0.113.9'));
    expect(member.statusCode).toBe(200);
  });

  it('counts every address in one IPv6 /64 as the same client', async () => {
    const instance = await buildApp();
    const results = await statuses(
      instance,
      Array.from({ length: 11 }, (_, i) =>
        enter(MEMBER, `2001:db8:1:2::${(i + 1).toString(16)}`),
      ),
    );
    expect(results.filter((s) => s === 429)).toHaveLength(1);
  });

  it('caps code entries for one email at 50 an hour across clients, even in a burst', async () => {
    const instance = await buildApp();
    const results = await statuses(
      instance,
      Array.from({ length: 80 }, (_, i) =>
        enter(MEMBER, `203.0.113.${String(i % 8)}`),
      ),
    );
    expect(results.filter((s) => s === 200)).toHaveLength(50);
    expect(results.filter((s) => s === 429)).toHaveLength(30);
  });
});
