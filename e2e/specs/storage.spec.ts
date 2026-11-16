import { expect, test, type Page } from '@playwright/test';

import {
  createIngredient,
  createRecipe,
  getPool,
  resetHouseholdData,
} from '../fixtures/db.ts';

test.describe('storage', () => {
  test.beforeEach(async () => {
    await resetHouseholdData();
  });

  test('Storage takes Ingredients’ place in the phone tab bar', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/plans');
    const tabBar = page.getByRole('navigation', { name: 'Primary' });
    await expect(tabBar.getByRole('link')).toHaveCount(4);
    await expect(tabBar.getByRole('link', { name: 'Ingredients' })).toHaveCount(
      0,
    );
    await tabBar.getByRole('link', { name: 'Storage' }).click();
    await expect(page).toHaveURL(/\/storage/);
    await expect(page.getByRole('heading', { name: 'Storage' })).toBeVisible();

    await page.goto('/settings');
    await expect(
      page.getByRole('link', { name: 'Ingredients', exact: true }),
    ).toBeVisible();
  });

  test('adds, combines and steps stock (manual verification step 1)', async ({
    page,
  }) => {
    await createIngredient({ name: 'Cod', unit: 'g', category: 'Fish' });
    const chickenId = await createIngredient({
      name: 'Chicken Thighs',
      unit: 'g',
      category: 'Meat',
    });
    await getPool().query(
      'update ingredients set average_shelf_life_days = 2 where id = $1',
      [chickenId],
    );
    await createRecipe({
      name: 'Beef Stew Base',
      baseServings: 4,
      isBase: true,
      ingredients: [
        { name: 'Beef', quantity: '800', unit: 'g', category: 'Meat' },
      ],
    });

    await page.goto('/storage?location=freezer');
    await addStock(page, { kind: 'Ingredient', search: 'Cod', amount: '500' });
    await addStock(page, {
      kind: 'Dish',
      search: 'Beef Stew',
      amount: '2',
    });
    const weekAgo = ymd(addDays(new Date(), -7));
    await addStock(page, {
      kind: 'Ingredient',
      search: 'Cod',
      amount: '300',
      addedOn: weekAgo,
    });

    const ingredients = page.getByRole('region', { name: 'Ingredients' });
    await expect(ingredients.getByRole('listitem')).toHaveCount(1);
    await expect(ingredients.getByText('800 g')).toBeVisible();
    await expect(ingredients.getByText('frozen 7 days ago')).toBeVisible();

    const dishes = page.getByRole('region', { name: 'Dishes' });
    await dishes.getByRole('button', { name: 'Less Beef Stew Base' }).click();
    await expect(dishes.getByText('1 portion', { exact: true })).toBeVisible();

    await page.getByRole('link', { name: /^Fridge/ }).click();
    await addStock(page, {
      kind: 'Ingredient',
      search: 'Chicken',
      amount: '200',
      expectedUseBy: ymd(addDays(new Date(), 2)),
    });
    await expect(
      page.getByRole('region', { name: 'Ingredients' }).getByText('200 g'),
    ).toBeVisible();
  });
});

async function addStock(
  page: Page,
  spec: {
    kind: 'Ingredient' | 'Dish';
    search: string;
    amount: string;
    addedOn?: string;
    expectedUseBy?: string;
  },
): Promise<void> {
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add to storage' });
  await dialog.getByRole('radio', { name: spec.kind }).click();
  await dialog.getByLabel(spec.kind, { exact: true }).fill(spec.search);
  await page
    .getByRole('option', { name: new RegExp(spec.search, 'i') })
    .first()
    .click();
  await dialog.getByLabel('Amount').fill(spec.amount);
  if (spec.addedOn) {
    await dialog.getByLabel(/^(Frozen|Added) on$/).fill(spec.addedOn);
  }
  if (spec.expectedUseBy) {
    await expect(dialog.getByLabel('Use by')).toHaveValue(spec.expectedUseBy);
  }
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dialog).toBeHidden();
}

function ymd(d: Date): string {
  const y = String(d.getFullYear());
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, days: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + days);
  return next;
}
