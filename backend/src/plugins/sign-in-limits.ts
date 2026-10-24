import { isIP } from 'node:net';

import { inArray, lt, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  ENTER_CODE_PATH,
  SEND_CODE_PATH,
  signInEmail,
  signInLimitKeys,
} from '../auth/sign-in-email.ts';
import type { Db } from '../db/index.ts';
import { rateLimitHits } from '../db/schema/rate-limits.ts';
import { sendRateLimited } from './rate-limit.ts';

const ONE_HOUR_SECONDS = 60 * 60;

export interface SignInLimitOptions {
  allowedEmails: readonly string[];
  // Per email. Bounds the emails Resend sends (DEC-45).
  sendsPerHour?: number;
  // Per email and client network. One attacker can't use up a person's tries.
  entriesPerClientPerHour?: number;
  // Per email across every client. Bounds the guesses against one code.
  entriesPerHour?: number;
}

export interface Hit {
  count: number;
  retryAfterSeconds: number;
}

// Fixed window, counted in one upsert so concurrent requests on any machine
// can't both read the old count. The upsert commits on its own, and expired
// rows are cleared in a separate statement that skips rows other requests
// hold: clearing inside the upsert's transaction let two requests each wait
// on the other's row. A deliberate exception to "multi-statement writes go
// through withTransaction" (cross-cutting #4, DEC-114): the two needn't
// succeed together.
export async function countHit(
  db: Db,
  key: string,
  windowSeconds: number,
): Promise<Hit> {
  const windowEnd = sql`now() + make_interval(secs => ${windowSeconds})`;
  const expired = sql`${rateLimitHits.resetAt} <= now()`;
  const [row] = await db
    .insert(rateLimitHits)
    .values({ key, count: 1, resetAt: windowEnd })
    .onConflictDoUpdate({
      target: rateLimitHits.key,
      set: {
        count: sql`case when ${expired} then 1 else ${rateLimitHits.count} + 1 end`,
        resetAt: sql`case when ${expired} then ${windowEnd} else ${rateLimitHits.resetAt} end`,
      },
    })
    .returning({
      count: rateLimitHits.count,
      retryAfterSeconds: sql<number>`greatest(1, ceil(extract(epoch from ${rateLimitHits.resetAt} - now())))::int`,
    });
  if (!row) throw new Error(`rate limit upsert returned no row for ${key}`);
  if (row.count === 1) await clearExpiredHits(db);
  return row;
}

async function clearExpiredHits(db: Db): Promise<void> {
  const expiredKeys = db
    .select({ key: rateLimitHits.key })
    .from(rateLimitHits)
    .where(lt(rateLimitHits.resetAt, sql`now()`))
    .for('update', { skipLocked: true });
  await db.delete(rateLimitHits).where(inArray(rateLimitHits.key, expiredKeys));
}

// IPv6 clients usually hold a whole /64, so each address in it would
// otherwise get its own allowance. Anything that isn't an IP address shares
// one bucket, so a forged value can't mint keys.
export function clientNetwork(ip: string): string {
  const address = ip.split('%', 1)[0] ?? ip;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1] && isIP(mapped[1]) === 4) return mapped[1];
  const version = isIP(address);
  if (version === 0) return 'invalid';
  if (version === 4) return address;
  const [head = '', tail] = address.split('::');
  const headGroups = head.split(':').filter((g) => g.length > 0);
  const tailGroups = (tail ?? '').split(':').filter((g) => g.length > 0);
  const zeros = Array.from<string>({
    length: Math.max(0, 8 - headGroups.length - tailGroups.length),
  }).fill('0');
  const groups = [...headGroups, ...zeros, ...tailGroups].slice(0, 4);
  return `${groups.map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

interface Limit {
  key: string;
  max: number;
}

export function registerSignInLimits(
  app: FastifyInstance,
  options: SignInLimitOptions,
): void {
  const allowedEmails = new Set(options.allowedEmails);
  const sendsPerHour = options.sendsPerHour ?? 5;
  const entriesPerClient = options.entriesPerClientPerHour ?? 10;
  const entriesPerHour = options.entriesPerHour ?? 50;

  function limitsFor(req: FastifyRequest): Limit[] {
    if (req.method !== 'POST') return [];
    const path = req.url.split('?', 1)[0];
    if (path !== SEND_CODE_PATH && path !== ENTER_CODE_PATH) return [];
    const email = signInEmail(req.body);
    // The auth route refuses other addresses outright (`plugins/auth.ts`);
    // counting them would only let strangers fill the table.
    if (!allowedEmails.has(email)) return [];
    if (path === SEND_CODE_PATH) {
      return [{ key: signInLimitKeys.send(email), max: sendsPerHour }];
    }
    // Client first, so one client's misses don't spend the shared allowance.
    return [
      {
        key: signInLimitKeys.enterFromClient(email, clientNetwork(req.ip)),
        max: entriesPerClient,
      },
      { key: signInLimitKeys.enter(email), max: entriesPerHour },
    ];
  }

  app.addHook(
    'preHandler',
    async (req: FastifyRequest, reply: FastifyReply) => {
      for (const limit of limitsFor(req)) {
        const hit = await countHit(app.db, limit.key, ONE_HOUR_SECONDS);
        if (hit.count > limit.max) {
          await sendRateLimited(reply, hit.retryAfterSeconds);
          return reply;
        }
      }
    },
  );
}
