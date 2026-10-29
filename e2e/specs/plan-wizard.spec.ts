import { expect, test } from '@playwright/test';

import { createRecipe, getPool, resetHouseholdData } from '../fixtures/db.ts';
import {
  FAKE_BATCH_BRIEF,
  openPlanReview,
  seedWizardRecipes,
} from '../fixtures/plan-wizard.ts';

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

  test('suggest again three times on one slot: each is different, and the rest of the plan stays', async ({
    page,
  }) => {
    await createRecipe({
      name: 'Veg Curry',
      baseServings: 4,
      ingredients: [
        { name: 'Red lentils', quantity: '200', unit: 'g', category: 'Pantry' },
      ],
    });
    await openPlanReview(page);
    const slots = page.locator('[data-slot-id]');
    const before = await slots.allInnerTexts();

    const seen = new Set<string>([before[1] ?? '']);
    for (let i = 0; i < 3; i += 1) {
      await slots.nth(1).getByRole('button').first().click();
      await page.getByRole('button', { name: 'Suggest again' }).click();
      await expect(page.getByRole('dialog')).toBeHidden();
      await expect(
        slots.nth(1).getByText('Something different for this meal.'),
      ).toBeVisible();
      const after = await slots.allInnerTexts();
      expect(after.filter((_, index) => index !== 1)).toEqual(
        before.filter((_, index) => index !== 1),
      );
      seen.add(after[1] ?? '');
    }
    // The first suggestion and three new ones, all different.
    expect(seen.size).toBe(4);
    await expect(slots.nth(1).getByText('AI suggestion')).toBeVisible();

    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page).toHaveURL(/\/plans\/\d+$/);
    expect(await planCount()).toBe(1);
  });

  test('the plans page’s entry opens the wizard, and is off while offline', async ({
    page,
    context,
  }) => {
    await page.goto('/plans');
    await page.getByRole('link', { name: 'Plan with AI' }).click();
    await expect(page).toHaveURL(/\/plans\/propose$/);
    await expect(
      page.getByRole('heading', { name: 'Which dates?' }),
    ).toBeVisible();

    await page.goto('/plans');
    await expect(
      page.getByRole('link', { name: 'Plan with AI' }),
    ).toBeVisible();
    await context.setOffline(true);
    await expect(
      page.getByRole('button', { name: 'Plan with AI' }),
    ).toBeDisabled();
    await context.setOffline(false);
    await expect(
      page.getByRole('link', { name: 'Plan with AI' }),
    ).toBeVisible();
  });

  test('a proposed Batch and its leftovers apply as the planner writes them, and the shopping list buys for the Batch', async ({
    page,
  }) => {
    await openPlanReview(page, FAKE_BATCH_BRIEF);
    await expect(page.locator('[data-slot-type="leftovers"]')).toHaveCount(1);
    await expect(page.getByRole('list', { name: 'Left in plan' })).toHaveCount(
      0,
    );

    // Discarding the leftovers leaves part of the Batch uneaten.
    await page.locator('[data-slot-type="leftovers"] button').first().click();
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(
      page.getByRole('list', { name: 'Left in plan' }),
    ).toContainText('Lentil Soup');
    await page.locator('[data-slot-type="empty"] button').first().click();
    await page.getByRole('button', { name: 'Restore suggestion' }).click();
    await expect(page.getByRole('list', { name: 'Left in plan' })).toHaveCount(
      0,
    );

    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page).toHaveURL(/\/plans\/\d+$/);
    await expect(page.locator('[data-slot-type="leftovers"]')).toHaveCount(1);
    await expect(page.locator('[data-slot-type="recipe"]')).toHaveCount(3);

    const planId = /\/plans\/(\d+)$/.exec(page.url())?.[1] ?? '';
    await page.goto(`/plans/${planId}/shopping`);
    // Three slots cook; the leftovers slot buys nothing.
    await expect(
      page
        .locator('[data-shopping-line]')
        .filter({ hasText: /Red lentils/i })
        .locator('[data-shopping-contributors] summary'),
    ).toHaveText('From 3 meals');
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
