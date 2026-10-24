import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type FullConfig } from '@playwright/test';

import {
  closePool,
  E2E_USER_NAME,
  resetHouseholdData,
  setUserName,
} from './fixtures/db.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.resolve(here, '.auth');
const STORAGE_STATE_PATH = path.join(AUTH_DIR, 'storage-state.json');

const E2E_EMAIL = process.env.E2E_EMAIL ?? 'e2e@example.com';
// Matches SIGN_IN_CODE_FIXED in playwright.config.ts.
const E2E_SIGN_IN_CODE = '42424242';

// One round of code sign-in via the UI:
//   1. Visit /sign-in, fill the email field, submit. The backend stores a
//      code and, with SIGN_IN_CODE_FIXED set, skips the email.
//   2. Type the code. The webServer runs with SIGN_IN_CODE_FIXED, so every
//      code is the known value; codes are stored hashed and can't be read
//      back out of Postgres.
//   3. Wait to leave /sign-in, then persist storageState — every spec
//      inherits it from playwright.config.
//
// The flow exercises the real sign-in handler end-to-end exactly once; later
// specs reuse the cookie, matching DEC-58's storageState contract.
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL =
    config.projects[0]?.use.baseURL ??
    process.env.BASE_URL ??
    'http://127.0.0.1:3100';

  await mkdir(AUTH_DIR, { recursive: true });
  await resetHouseholdData();

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${baseURL}/sign-in`);
    await page.getByLabel('Email').fill(E2E_EMAIL);
    await page.getByRole('button', { name: 'Send sign-in code' }).click();
    // The form signs in by itself once the eighth digit is in.
    await page.getByLabel('Sign-in code').fill(E2E_SIGN_IN_CODE);
    await page.waitForURL((url) => url.pathname !== '/sign-in');
    await context.storageState({ path: STORAGE_STATE_PATH });

    // A new user's `name` is blank; without this the authed gate redirects
    // every spec to /welcome. getSession reads the name live from the DB, so
    // stamping it after storageState is saved still takes effect for every
    // spec.
    await setUserName(E2E_EMAIL, E2E_USER_NAME);
  } finally {
    await context.close();
    await browser.close();
    await closePool();
  }
}
