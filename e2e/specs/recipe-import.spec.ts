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

// Documents are read in the browser: a text or Markdown file opens in a text
// box and imports as pasted text; a saved web page is pruned and read like a
// linked page, without a fetch.
test.describe('recipe import from a document', () => {
  const SAVED_LINK = 'https://recipes.example/weeknight-pasta';
  const SAVED_PAGE = `<!DOCTYPE html>
<!-- saved from url=(0040)${SAVED_LINK} -->
<html><head>
<title>Weeknight Pasta | Recipes</title>
<link rel="canonical" href="${SAVED_LINK}">
<script type="application/ld+json">${JSON.stringify({
    '@type': 'Recipe',
    name: 'Weeknight Pasta',
    recipeIngredient: ['2 tbsp olive oil', 'Pepper to taste'],
    recipeInstructions: [{ '@type': 'HowToStep', text: 'Cook everything.' }],
  })}</script>
<script>window.tracking = true;</script>
</head><body><main><h1>Weeknight Pasta</h1><p>Cook everything together.</p></main></body></html>`;

  test.beforeEach(async () => {
    await resetHouseholdData();
    await createIngredient({
      name: 'Olive oil',
      unit: 'ml',
      category: 'Pantry',
    });
  });

  async function chooseDocument(
    page: Page,
    name: string,
    mimeType: string,
    content: string,
  ): Promise<void> {
    await page.goto('/recipes/import');
    await page.getByRole('button', { name: 'Document' }).click();
    await page.getByLabel('Choose a document to import').setInputFiles({
      name,
      mimeType,
      buffer: Buffer.from(content),
    });
  }

  test('a Markdown file, trimmed in its text box, is reviewed and created', async ({
    page,
  }) => {
    await chooseDocument(
      page,
      'weeknight-pasta.md',
      'application/octet-stream',
      `# Weeknight Pasta\n\nA story about pasta.\n\n${RECIPE_TEXT}`,
    );
    const box = page.getByLabel('From weeknight-pasta.md');
    await expect(box).toHaveValue(/A story about pasta/);
    await box.fill(RECIPE_TEXT);
    await page.getByRole('button', { name: 'Import', exact: true }).click();

    await expect(page).toHaveURL(/\/recipes\/import\/\d+$/);
    await expect(
      page.getByRole('heading', { name: 'Review import' }),
    ).toBeVisible();
    const original = page.getByRole('complementary', {
      name: 'Original text',
    });
    await expect(original).toContainText('2 tbsp olive oil');
    await expect(original).not.toContainText('A story about pasta');

    await page.getByRole('button', { name: 'Create recipe' }).click();
    await expect(page).toHaveURL(/\/recipes\/\d+$/);
    await expect(
      page.getByRole('heading', { name: 'Weeknight Pasta', level: 1 }),
    ).toBeVisible();
  });

  test('a saved web page is reviewed beside its text and source link, and created', async ({
    page,
  }) => {
    await chooseDocument(page, 'Weeknight Pasta.html', 'text/html', SAVED_PAGE);
    await expect(page.getByText(/^Saved web page ·/)).toBeVisible();
    await page.getByRole('button', { name: 'Import', exact: true }).click();

    await expect(page).toHaveURL(/\/recipes\/import\/\d+$/);
    const original = page.getByRole('complementary', {
      name: 'Original document',
    });
    await expect(original).toContainText('Weeknight Pasta.html');
    await expect(
      original.getByRole('link', {
        name: `${SAVED_LINK} (opens in a new tab)`,
      }),
    ).toHaveAttribute('href', SAVED_LINK);
    await expect(original).toContainText('Cook everything together.');
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue(
      'Linked Recipe',
    );

    const { rows: drafts } = await getPool().query<{ data: string }>(
      `select draft_data::text as data from recipe_drafts where kind = 'import'`,
    );
    expect(drafts[0]?.data).not.toContain('tracking');
    expect(drafts[0]?.data).not.toContain('ld+json');

    await page.getByRole('button', { name: 'Create recipe' }).click();
    await expect(page).toHaveURL(/\/recipes\/\d+$/);
    const { rows } = await getPool().query<{ sourceUrl: string | null }>(
      `select source_url as "sourceUrl" from recipes`,
    );
    expect(rows).toEqual([{ sourceUrl: SAVED_LINK }]);
  });
});
