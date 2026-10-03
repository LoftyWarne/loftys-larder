import { expect, test } from '@playwright/test';

import { createRecipe, resetHouseholdData } from '../fixtures/db.ts';

// The recipes page filters by ingredient, time and source, and keeps them in
// the URL so they survive opening a recipe and pressing Back (DEC-100).
test.describe('recipe filters', () => {
  test.beforeEach(async () => {
    await resetHouseholdData();
    await createRecipe({
      name: 'Chicken traybake',
      baseServings: 4,
      source: 'Mob Kitchen',
      activeTimeMins: 15,
      totalTimeMins: 45,
      ingredients: [
        { name: 'Chicken', quantity: '600', unit: 'g', category: 'Meat' },
        { name: 'Leek', quantity: '2', unit: 'piece', category: 'Fruit & Veg' },
      ],
    });
    await createRecipe({
      name: 'Chicken pie',
      baseServings: 4,
      source: 'BBC Good Food',
      activeTimeMins: 30,
      totalTimeMins: 90,
      ingredients: [
        { name: 'Chicken', quantity: '500', unit: 'g', category: 'Meat' },
      ],
    });
    await createRecipe({
      name: 'Leek soup',
      baseServings: 2,
      activeTimeMins: 10,
      totalTimeMins: 30,
      ingredients: [
        { name: 'Leek', quantity: '3', unit: 'piece', category: 'Fruit & Veg' },
      ],
    });
  });

  test('ingredient and time filters narrow the list and survive Back', async ({
    page,
  }) => {
    await page.goto('/recipes');
    await expect(page.getByText('Leek soup')).toBeVisible();

    await page.getByRole('button', { name: 'Ingredients' }).click();
    await page
      .getByRole('dialog', { name: 'Ingredients' })
      .getByRole('combobox', { name: 'Find an ingredient' })
      .fill('chick');
    await page.getByRole('option', { name: 'Chicken' }).click();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.getByText('Chicken pie')).toBeVisible();
    await expect(page.getByText('Leek soup')).toBeHidden();

    await page.getByRole('button', { name: 'Total time' }).click();
    const upTo60 = page.getByRole('radio', { name: 'Up to 60 min' });
    await upTo60.click();
    await expect(upTo60).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(page.getByText('Chicken traybake')).toBeVisible();
    await expect(page.getByText('Chicken pie')).toBeHidden();
    await expect(page).toHaveURL(/maxTotal=60/);

    await page.getByText('Chicken traybake').click();
    await expect(
      page.getByRole('heading', { name: 'Chicken traybake' }),
    ).toBeVisible();
    await page.goBack();

    await expect(
      page.getByRole('button', { name: 'Ingredients: Chicken' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Total time: up to 60 min' }),
    ).toBeVisible();
    await expect(page.getByText('Chicken traybake')).toBeVisible();
    await expect(page.getByText('Chicken pie')).toBeHidden();

    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.getByText('Leek soup')).toBeVisible();
    await expect(page.getByText('Chicken pie')).toBeVisible();
  });

  test('the source filter lists only sources in use', async ({ page }) => {
    await page.goto('/recipes');
    await page.getByRole('button', { name: 'Source' }).click();
    const panel = page.getByRole('dialog', { name: 'Source' });
    await expect(panel.getByRole('checkbox')).toHaveCount(2);
    await panel.getByRole('checkbox', { name: 'BBC Good Food' }).click();
    await page.keyboard.press('Escape');

    await expect(page.getByText('Chicken pie')).toBeVisible();
    await expect(page.getByText('Chicken traybake')).toBeHidden();
    await expect(page.getByText('Leek soup')).toBeHidden();
  });
});
