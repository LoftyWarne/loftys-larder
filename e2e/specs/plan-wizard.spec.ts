import { expect, test } from '@playwright/test';

import { getPool, resetHouseholdData } from '../fixtures/db.ts';
import { openPlanReview, seedWizardRecipes } from '../fixtures/plan-wizard.ts';

// The planning wizard, visited directly: nothing links to it yet.

async function planCount(): Promise<number> {
  const result = await getPool().query<{ count: string }>(
    'select count(*) from meal_plans',
  );
  return Number(result.rows[0]?.count ?? 0);
}

test.describe('planning wizard', () => {
  test.beforeEach(async () => {
    await resetHouseholdData();
    await seedWizardRecipes();
  });

  test('wizard → review → Apply → planner, with the AI badge only in review', async ({
    page,
  }) => {
    await openPlanReview(page);
    await expect(page.getByText('AI suggestion').first()).toBeVisible();
    await expect(
      page.getByText('A varied week from your library.'),
    ).toBeVisible();

    // Discard the first suggestion.
    await page
      .getByRole('button', { name: /Lentil Soup/ })
      .first()
      .click();
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(page.getByText('Discarded')).toBeVisible();

    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page).toHaveURL(/\/plans\/\d+$/);
    await expect(page.locator('[data-slot-id]').first()).toBeVisible();
    await expect(page.locator('[data-slot-type="recipe"]')).toHaveCount(3);
    await expect(page.locator('[data-slot-type="empty"]')).toHaveCount(1);
    await expect(page.getByText('AI suggestion')).toHaveCount(0);
    expect(await planCount()).toBe(1);
  });

  test('reloading before Apply creates nothing', async ({ page }) => {
    await openPlanReview(page);
    page.once('dialog', (dialog) => {
      void dialog.accept();
    });
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Which dates?' }),
    ).toBeVisible();
    expect(await planCount()).toBe(0);
  });
});
