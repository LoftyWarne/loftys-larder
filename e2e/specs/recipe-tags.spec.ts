import { expect, test } from '@playwright/test';

import {
  createPlan,
  createRecipe,
  resetHouseholdData,
} from '../fixtures/db.ts';

// Tag a recipe in the editor by typing a new tag, then use that tag to narrow
// the recipes page (DEC-100) and the planner's Recipe Bank (DEC-97). The
// default Desktop Chrome viewport is `lg+`, so the bank is rendered (DEC-85).
test.describe('recipe tags', () => {
  test.beforeEach(async () => {
    await resetHouseholdData();
  });

  test('a tag added in the editor filters the recipes page and the bank', async ({
    page,
  }) => {
    const tagged = await createRecipe({
      name: 'Chickpea curry',
      baseServings: 4,
      ingredients: [],
    });
    await createRecipe({
      name: 'Slow roast lamb',
      baseServings: 6,
      ingredients: [],
    });

    await page.goto(`/recipes/${String(tagged.id)}/edit`);
    await page.getByRole('combobox', { name: 'Add a tag' }).fill('Weeknight');
    await page.getByRole('option', { name: 'Add “Weeknight”' }).click();
    await expect(
      page.getByRole('button', { name: 'Remove tag Weeknight' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Save tags' }).click();
    await expect(
      page.getByRole('form', { name: 'Tags' }).getByRole('status'),
    ).toHaveText('Saved.');

    await page.goto('/recipes');
    await expect(page.getByText('Slow roast lamb')).toBeVisible();
    await page.getByRole('button', { name: 'Tags' }).click();
    await page
      .getByRole('dialog', { name: 'Tags' })
      .getByRole('checkbox', { name: 'Weeknight' })
      .click();
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('button', { name: 'Tags: Weeknight' }),
    ).toBeVisible();
    await expect(page.getByText('Chickpea curry')).toBeVisible();
    await expect(page.getByText('Slow roast lamb')).toBeHidden();

    const today = new Date().toISOString().slice(0, 10);
    const plan = await createPlan(today, today);
    await page.goto(`/plans/${String(plan.id)}`);
    const bank = page.getByRole('complementary', { name: 'Recipe bank' });
    await expect(bank.getByText('Slow roast lamb')).toBeVisible();
    await bank
      .getByRole('group', { name: 'Filter by tag' })
      .getByRole('button', { name: 'Weeknight' })
      .click();
    await expect(bank.getByText('Chickpea curry')).toBeVisible();
    await expect(bank.getByText('Slow roast lamb')).toBeHidden();
  });
});
