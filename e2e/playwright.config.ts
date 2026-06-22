import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

// Playwright doesn't auto-load `.env` (unlike `tsx --env-file-if-exists`).
// Node 24's built-in `loadEnvFile` populates `process.env` without a
// dependency; the call is a no-op if the file is missing.
try {
  process.loadEnvFile(path.join(here, '.env'));
} catch {
  // .env is optional — env vars come from CI directly in that case.
}

// Backend + frontend run same-origin out of the bundled server (matches prod
// per the Dockerfile: STATIC_DIR points at the frontend dist). One port, one
// URL, no Vite proxy.
const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:3100';
const PORT = Number(new URL(BASE_URL).port);

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://lofty:lofty@localhost:5433/lofty_e2e';

// The magic-link sender is silenced via the existing `withAllowList` filter —
// the e2e email is deliberately NOT in MAGIC_LINK_ALLOWED_EMAILS, so the
// Resend call never fires while Better Auth still writes the verification row
// global-setup needs.
const E2E_EMAIL = process.env.E2E_EMAIL ?? 'e2e@example.com';

export default defineConfig({
  testDir: './specs',
  outputDir: './test-results',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',

  globalSetup: './global-setup.ts',
  timeout: 30_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    storageState: path.resolve(here, '.auth/storage-state.json'),
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: `node ${path.join(repoRoot, 'backend/dist/server.js')}`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(PORT),
      LOG_LEVEL: 'warn',
      DATABASE_URL,
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ??
        'e2e-secret-thirty-two-characters-long!!',
      BETTER_AUTH_URL: BASE_URL,
      MAGIC_LINK_TRUSTED_ORIGIN: BASE_URL,
      RESEND_API_KEY: 're_unused_for_e2e',
      // E2E_EMAIL is deliberately omitted from this allowlist — the magic-link
      // send is silently dropped (see top-of-file comment).
      MAGIC_LINK_ALLOWED_EMAILS: 'blocked@example.com',
      MAGIC_LINK_FROM: 'magic@loftys-larder.co.uk',
      CLOUDINARY_CLOUD_NAME: 'e2e-cloud',
      CLOUDINARY_API_KEY: 'e2e-key',
      CLOUDINARY_API_SECRET: 'e2e-secret',
      ALLOWED_ORIGIN: BASE_URL,
      STATIC_DIR: path.join(repoRoot, 'frontend/dist'),
      AXIOM_ENDPOINT: 'https://api.axiom.co',
    },
  },

  metadata: { E2E_EMAIL },
});
