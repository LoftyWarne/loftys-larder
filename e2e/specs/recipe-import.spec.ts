import { expect, test, type Page } from '@playwright/test';

import {
  createIngredient,
  getPool,
  resetHouseholdData,
} from '../fixtures/db.ts';

// Recipe Import from pasted text, end to end. The backend runs the `fake`
// reader under NODE_ENV=test: it names the recipe after the first line,
// matches the household's first ingredient as "2 tbsp <name>" converted to
// 30, and proposes a new ingredient, "Fake Pepper", with a nominal quantity.
// Markers such as `[fake:not-a-recipe]` pick its other outcomes.

const RECIPE_TEXT = [
  'Weeknight Pasta',
  '2 tbsp olive oil',
  'Pepper to taste',
  'Cook everything together.',
].join('\n');

async function importPastedRecipe(
  page: Page,
  text = RECIPE_TEXT,
): Promise<void> {
  await page.goto('/recipes/import');
  await page.getByLabel('Recipe text').fill(text);
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page).toHaveURL(/\/recipes\/import\/\d+$/);
  await expect(
    page.getByRole('heading', { name: 'Review import' }),
  ).toBeVisible();
}

test.describe('recipe import from pasted text', () => {
  test.beforeEach(async () => {
    await resetHouseholdData();
    await createIngredient({
      name: 'Olive oil',
      unit: 'ml',
      category: 'Pantry',
    });
  });

  test('paste, review, correct and create', async ({ page }) => {
    await page.goto('/recipes');
    await page.getByRole('button', { name: 'New recipe' }).click();
    await page.getByRole('link', { name: 'Import' }).click();
    await expect(page).toHaveURL(/\/recipes\/import$/);

    await importPastedRecipe(page);

    await expect(
      page.getByText('This proposal came from the fake reader.'),
    ).toBeVisible();
    await expect(
      page.getByText('2 tbsp olive oil', { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('New ingredient name for row 2')).toHaveValue(
      'Fake Pepper',
    );

    const quantity = page.getByLabel('Quantity for row 1');
    await expect(quantity).toHaveValue('30');
    await expect(page.getByText('Converted — check the amount')).toBeVisible();
    await quantity.fill('45');
    await expect(page.getByText('Converted — check the amount')).toHaveCount(0);

    await page.getByRole('button', { name: 'Create recipe' }).click();

    await expect(page).toHaveURL(/\/recipes\/\d+$/);
    await expect(
      page.getByRole('heading', { name: 'Weeknight Pasta', level: 1 }),
    ).toBeVisible();
    // The calorie Estimate was left, so the label stays (DEC-106).
    await expect(
      page.getByRole('heading', { name: 'Nutrition per serving · estimated' }),
    ).toBeVisible();

    await page.goto('/ingredients');
    await expect(page.getByText('Fake Pepper', { exact: true })).toBeVisible();

    await page.goto('/recipes/import');
    await expect(
      page.getByRole('heading', { name: 'Import a recipe' }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Imports in progress' }),
    ).toHaveCount(0);
  });

  test('resumes after a reload with corrections kept', async ({ page }) => {
    await importPastedRecipe(page);
    const reviewUrl = page.url();

    const saved = page.waitForResponse(
      (response) =>
        response.url().includes('/api/trpc/recipeDrafts.upsert') &&
        response.ok(),
    );
    await page.getByLabel('Quantity for row 1').fill('45');
    await saved;

    await page.reload();
    await expect(page.getByLabel('Quantity for row 1')).toHaveValue('45');
    await expect(page.getByText('Converted — check the amount')).toHaveCount(0);

    await page.goto('/recipes/import');
    await page.getByRole('link', { name: 'Resume Weeknight Pasta' }).click();
    await expect(page).toHaveURL(reviewUrl);
    await expect(page.getByLabel('Quantity for row 1')).toHaveValue('45');
  });

  test('discarding an import creates nothing', async ({ page }) => {
    await importPastedRecipe(page);

    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await page.getByRole('button', { name: 'Discard import' }).click();

    await expect(page).toHaveURL(/\/recipes\/import$/);
    await expect(
      page.getByRole('region', { name: 'Imports in progress' }),
    ).toHaveCount(0);
    const { rows } = await getPool().query<{
      recipes: number;
      proposed: number;
      drafts: number;
    }>(
      `select
         (select count(*) from recipes)::int as recipes,
         (select count(*) from ingredients where name = 'Fake Pepper')::int as proposed,
         (select count(*) from recipe_drafts where kind = 'import')::int as drafts`,
    );
    expect(rows[0]).toEqual({ recipes: 0, proposed: 0, drafts: 0 });
  });

  test('an import in progress stays off the new-recipe form', async ({
    page,
  }) => {
    await importPastedRecipe(page);

    await page.goto('/recipes/new');
    await expect(
      page.getByRole('heading', { name: 'New recipe' }),
    ).toBeVisible();
    await expect(page.getByLabel('Name')).toHaveValue('');
    await expect(page.getByText('Unsaved draft restored.')).toHaveCount(0);
  });

  test('picks one of several recipes', async ({ page }) => {
    await page.goto('/recipes/import');
    await page.getByLabel('Recipe text').fill(`[fake:several]\n${RECIPE_TEXT}`);
    await page.getByRole('button', { name: 'Import' }).click();

    await page.getByRole('button', { name: 'Fake Salad' }).click();

    await expect(page).toHaveURL(/\/recipes\/import\/\d+$/);
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue(
      'Fake Salad',
    );
  });

  test('says when the text isn’t a recipe, keeping it', async ({ page }) => {
    const text = '[fake:not-a-recipe]\nmilk, eggs, bread';
    await page.goto('/recipes/import');
    await page.getByLabel('Recipe text').fill(text);
    await page.getByRole('button', { name: 'Import' }).click();

    await expect(page.getByRole('alert')).toHaveText(
      'Couldn’t find a recipe in that.',
    );
    await expect(page.getByLabel('Recipe text')).toHaveValue(text);
  });
});
