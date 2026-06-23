import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { databaseUrlSchema } from './config.ts';

// Standalone migration entrypoint, bundled to dist/migrate.js and run as the
// Fly `release_command` before each new version goes live (DEC-40, DEC-65).
// Uses drizzle-orm's programmatic migrator — part of the runtime dependency —
// so production never needs drizzle-kit (a dev-only CLI), keeping the single
// esbuild bundle intact (DEC-61).
//
// The migrator reads the generated SQL plus meta/_journal.json at runtime, so
// the `drizzle/` folder is copied alongside this bundle into the runtime image.
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(here, 'drizzle');

const databaseUrl = databaseUrlSchema.parse(process.env.DATABASE_URL);
const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const db = drizzle(pool);

try {
  await migrate(db, { migrationsFolder });
} finally {
  await pool.end();
}
