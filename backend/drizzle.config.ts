import { defineConfig } from 'drizzle-kit';

import { loadConfig } from './src/config.ts';

const config = loadConfig();

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  casing: 'snake_case',
  dbCredentials: {
    url: config.DATABASE_URL,
  },
});
