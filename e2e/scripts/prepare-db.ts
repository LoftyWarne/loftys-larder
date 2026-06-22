import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { closePool, getPool, HOUSEHOLD_ID } from '../fixtures/db.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const INGREDIENT_CATEGORIES = [
  'Fruit & Veg',
  'Dairy',
  'Meat',
  'Fish',
  'Pantry',
  'Frozen',
  'Bakery',
  'Drinks',
];
const UNITS_OF_MEASUREMENT = [
  'g',
  'kg',
  'ml',
  'l',
  'tsp',
  'tbsp',
  'piece',
  'pinch',
  'cup',
];
const PREPARATION_TYPES = [
  'raw',
  'chopped',
  'diced',
  'sliced',
  'minced',
  'grated',
];
const MEAL_OCCASIONS = ['Lunch', 'Dinner'];

// Run drizzle-kit migrate via the backend workspace so the e2e DB matches
// the production schema exactly. `drizzle.config.ts` calls `loadConfig`,
// which validates the FULL backend env — DATABASE_URL alone isn't enough.
// We supply dummy placeholders for the auth/email/cloudinary required vars
// because drizzle-kit only ever uses DATABASE_URL.
function runMigrations(): void {
  const result = spawnSync(
    'pnpm',
    ['--filter', '@loftys-larder/backend', 'db:migrate'],
    {
      cwd: repoRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        BETTER_AUTH_SECRET:
          process.env.BETTER_AUTH_SECRET ??
          'e2e-prepare-db-thirty-two-chars-long!!',
        BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? 'http://127.0.0.1:3100',
        RESEND_API_KEY: process.env.RESEND_API_KEY ?? 're_unused',
        MAGIC_LINK_TRUSTED_ORIGIN:
          process.env.MAGIC_LINK_TRUSTED_ORIGIN ?? 'http://127.0.0.1:3100',
        MAGIC_LINK_ALLOWED_EMAILS:
          process.env.MAGIC_LINK_ALLOWED_EMAILS ?? 'unused@example.com',
        CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME ?? 'unused',
        CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY ?? 'unused',
        CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET ?? 'unused',
        ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN ?? 'http://127.0.0.1:3100',
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `db:migrate failed with exit code ${String(result.status)}`,
    );
  }
}

// Idempotent (ON CONFLICT DO NOTHING). The seed mirrors
// `backend/src/db/seeds/{reference,household}.ts` — only the mandatory rows
// `runSeeds` writes; the dev-only sample recipes from `runDevSeeds` are
// deliberately excluded.
async function seedReferenceAndHousehold(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('begin');

    await client.query(
      `insert into households (id, name) values ($1, $2)
       on conflict (id) do nothing`,
      [HOUSEHOLD_ID, "Lofty's Larder"],
    );

    for (const name of INGREDIENT_CATEGORIES) {
      await client.query(
        `insert into ingredient_categories (name) values ($1)
         on conflict (name) do nothing`,
        [name],
      );
    }
    for (const name of UNITS_OF_MEASUREMENT) {
      await client.query(
        `insert into units_of_measurement (name) values ($1)
         on conflict (name) do nothing`,
        [name],
      );
    }
    for (const name of PREPARATION_TYPES) {
      await client.query(
        `insert into preparation_types (name) values ($1)
         on conflict (name) do nothing`,
        [name],
      );
    }
    for (const name of MEAL_OCCASIONS) {
      await client.query(
        `insert into meal_occasions (name) values ($1)
         on conflict (name) do nothing`,
        [name],
      );
    }

    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  runMigrations();
  await seedReferenceAndHousehold();
  process.stdout.write('e2e: db prepared\n');
}

try {
  await main();
} catch (err) {
  process.stderr.write(`e2e prepare-db failed: ${String(err)}\n`);
  process.exitCode = 1;
} finally {
  await closePool();
}
