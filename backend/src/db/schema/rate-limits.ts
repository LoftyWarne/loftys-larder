import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// Fixed-window counters for the sign-in limits (DEC-114). Held in Postgres so
// every machine shares them; the general per-IP limits stay in memory.
// Infrastructure, like the Better Auth tables, so not household-scoped.
export const rateLimitHits = pgTable('rate_limit_hits', {
  key: text().primaryKey(),
  count: integer().notNull(),
  resetAt: timestamp({ withTimezone: true }).notNull(),
});
