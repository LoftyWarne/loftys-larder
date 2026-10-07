import { expect, test } from '@playwright/test';

import { createRecipe, resetHouseholdData } from '../fixtures/db.ts';

// Health scoring on the `fake` scorer (DEC-112), which scores every recipe 7
// with this summary.
const FAKE_SUMMARY = 'Plenty of vegetables and fibre, but quite a lot of salt.';

test.describe('AI health scores', () => {
  test.beforeEach(async () => {
    await resetHouseholdData();
  });

  async function lentilSoup() {
    return createRecipe({
      name: 'Lentil soup',
      baseServings: 4,
      ingredients: [
        {
          name: 'Red lentils',
          quantity: '250',
          unit: 'g',
          category: 'Pantry',
        },
      ],
      method: [{ instruction: 'Simmer the lentils until soft.' }],
    });
  }

  test('Save & Finish leads to a score on the recipe page and its card', async ({
    page,
  }) => {
    const recipe = await lentilSoup();

    await page.goto(`/recipes/${String(recipe.id)}/edit`);
    await page.getByRole('button', { name: 'Save & Finish' }).click();
    await expect(page).toHaveURL(
      new RegExp(`/recipes/${String(recipe.id)}/?$`),
    );

    const section = page.getByRole('region', { name: 'AI health score' });
    await expect(section).toContainText(FAKE_SUMMARY);
    await expect(section).toContainText('7out of 10');
    await expect(section).toContainText('Suggestion:');
    await expect(section).toContainText('by fake');
    await expect(
      section.getByRole('button', { name: 'Rescore' }),
    ).toBeVisible();

    await page.goto('/recipes');
    await expect(page.getByText('7/10', { exact: true })).toBeVisible();
    await expect(page.getByText('AI health score 7 out of 10')).toBeAttached();
  });

  test('Score on the recipe page scores an unscored recipe', async ({
    page,
  }) => {
    const recipe = await lentilSoup();

    await page.goto(`/recipes/${String(recipe.id)}`);
    const section = page.getByRole('region', { name: 'AI health score' });
    await expect(section).toContainText('Not scored yet');
    await section.getByRole('button', { name: 'Score' }).click();

    await expect(section).toContainText(FAKE_SUMMARY);
    await expect(
      section.getByRole('button', { name: 'Rescore' }),
    ).toBeVisible();
  });
});
