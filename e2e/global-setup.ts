import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, request, type FullConfig } from '@playwright/test';

import {
  closePool,
  getLatestVerificationFor,
  resetHouseholdData,
} from './fixtures/db.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.resolve(here, '.auth');
const STORAGE_STATE_PATH = path.join(AUTH_DIR, 'storage-state.json');

const E2E_EMAIL = process.env.E2E_EMAIL ?? 'e2e@example.com';

// One round of magic-link sign-in via the UI:
//   1. Visit /sign-in, fill the email field, submit.
//   2. Backend POSTs /api/auth/sign-in/magic-link which writes a verification
//      row (and silently drops the Resend send via `withAllowList`).
//   3. Read the latest verification row for E2E_EMAIL out of Postgres — the
//      magic-link plugin stores the raw token in `verifications.identifier`.
//   4. Hit /api/auth/magic-link/verify?token=... with a Playwright request
//      context so the session cookie is captured.
//   5. Persist storageState — every spec inherits it from playwright.config.
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
    await page.getByRole('button', { name: 'Send sign-in link' }).click();
    await page.getByRole('heading', { name: 'Check your email' }).waitFor();

    const verification = await getLatestVerificationFor(E2E_EMAIL);
    const verifyURL = new URL(`${baseURL}/api/auth/magic-link/verify`);
    verifyURL.searchParams.set('token', verification.identifier);
    verifyURL.searchParams.set('callbackURL', '/');

    // A fresh request context — driving the GET through the page would let
    // the SPA re-render mid-flight; we want the raw cookie. `maxRedirects: 0`
    // is irrelevant here because Better Auth issues 302 to the callbackURL on
    // success, but the cookie lands on the verify response itself.
    const apiContext = await request.newContext({ baseURL });
    const response = await apiContext.get(verifyURL.toString(), {
      maxRedirects: 0,
    });
    if (![200, 302].includes(response.status())) {
      throw new Error(
        `Verify endpoint returned ${String(response.status())}: ${await response.text()}`,
      );
    }
    await apiContext.storageState({ path: STORAGE_STATE_PATH });
    await apiContext.dispose();
  } finally {
    await context.close();
    await browser.close();
    await closePool();
  }
}
