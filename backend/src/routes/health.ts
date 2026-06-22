import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/index.ts';

const PROBE_TIMEOUT_MS = 2_000;

type ProbeResult =
  | { ok: true }
  | { ok: false; reason: 'timeout' }
  | { ok: false; reason: 'error'; err: unknown };

async function probeDb(db: Db, timeoutMs: number): Promise<ProbeResult> {
  // Postgres `statement_timeout` would only cover the query itself, not the
  // pool's connection-acquisition wait. Racing in JS bounds the whole probe.
  const probe = db.execute(sql`select 1`);
  // If the timeout wins, the underlying promise may settle later with no
  // listener. Attach a no-op catch so a late reject isn't surfaced as an
  // unhandled rejection.
  probe.catch(() => undefined);

  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
      }, timeoutMs);
    });
    const result = await Promise.race([
      probe.then(() => 'ok' as const),
      timeout,
    ]);
    return result === 'ok' ? { ok: true } : { ok: false, reason: 'timeout' };
  } catch (err) {
    return { ok: false, reason: 'error', err };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function registerHealth(app: FastifyInstance): void {
  // `logLevel: 'warn'` silences Fastify's per-request info access log so
  // Fly's frequent liveness probes don't dominate Axiom volume; failures
  // still log because the handler emits a `warn` explicitly.
  app.get('/api/health', { logLevel: 'warn' }, async (req, reply) => {
    const result = await probeDb(req.server.db, PROBE_TIMEOUT_MS);
    if (result.ok) {
      return reply.code(200).send({ ok: true });
    }
    if (result.reason === 'timeout') {
      req.log.warn({ reason: 'timeout' }, 'health probe failed');
    } else {
      req.log.warn({ err: result.err, reason: 'error' }, 'health probe failed');
    }
    return reply.code(503).send({ ok: false });
  });
}
