import { expect, test } from '@playwright/test';

import { E2E_USER_NAME, resetHouseholdData } from '../fixtures/db.ts';

// Confirms global-setup left a usable storageState behind: the storage state
// loaded via playwright.config carries the Better Auth session cookie, so
// visiting `/` lands on the authed home view rather than bouncing to /sign-in.
test.describe('storageState authenticates the session', () => {
  test.beforeEach(async () => {
    await resetHouseholdData();
  });

  test('lands on the authed home page without going through /sign-in', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/$/);
    // The authed root is `/`; the public sign-in route would have us at
    // `/sign-in`, and a nameless user would be bounced to `/welcome`. The
    // greeting heading (which carries the set name) confirms we landed on the
    // real home view rather than either gate.
    await expect(
      page.getByRole('heading', { name: new RegExp(E2E_USER_NAME) }),
    ).toBeVisible();
  });
});
