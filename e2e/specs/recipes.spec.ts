import { expect, test } from '@playwright/test';

import { resetHouseholdData } from '../fixtures/db.ts';

// Drive the recipe editor end-to-end: fill the header form on /recipes/new,
// submit, and verify the new recipe appears on /recipes. Saves the recipe id
// (recipe header is enough — ingredients/method are separate editors that
// FEAT-53's critical path does not require us to touch).
test.describe('recipe creation flows through to browse', () => {
  test.beforeEach(async () => {
    await resetHouseholdData();
  });

  test('the new recipe is visible on /recipes after the editor saves', async ({
    page,
  }) => {
    const recipeName = `Sourdough Toast ${Date.now().toString(36)}`;

    await page.goto('/recipes/new');
    await expect(
      page.getByRole('heading', { name: 'New recipe' }),
    ).toBeVisible();

    await page.getByLabel('Name').fill(recipeName);
    // baseServings defaults to 2 — leave it. No other required fields.
    await page.getByRole('button', { name: 'Create recipe' }).click();

    // The editor navigates to /recipes/<id>/edit on success.
    await expect(page).toHaveURL(/\/recipes\/\d+\/edit/);

    await page.goto('/recipes');
    await expect(page.getByRole('heading', { name: 'Recipes' })).toBeVisible();

    // The browse list renders one card per recipe; we only care that ours
    // shows up. Looking it up by name keeps the spec robust to card markup
    // changes.
    await expect(page.getByText(recipeName, { exact: true })).toBeVisible();
  });
});
