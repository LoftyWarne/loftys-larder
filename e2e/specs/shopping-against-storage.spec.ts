import { expect, test } from '@playwright/test';

import {
  assignRecipeToSlot,
  createIngredient,
  createPlan,
  createRecipe,
  createStockItem,
  getPool,
  resetHouseholdData,
} from '../fixtures/db.ts';

test.describe('shopping against storage, and Staples', () => {
  test.beforeEach(async () => {
    await resetHouseholdData();
  });

  // Manual verification step 1. e2e can't move the clock, so "the day after
  // that dish" is the Reservation's day moved into the past.
  test('uses held cod instead of buying it, and it leaves storage after the dish', async ({
    page,
  }) => {
    const cod = await createIngredient({
      name: 'Cod',
      unit: 'g',
      category: 'Fish',
    });
    const pie = await createRecipe({
      name: 'Fish pie',
      baseServings: 1,
      ingredients: [
        { name: 'Cod', quantity: '400', unit: 'g', category: 'Fish' },
      ],
    });
    const today = ymd(new Date());
    const tomorrow = ymd(addDays(new Date(), 1));
    await createStockItem({
      location: 'freezer',
      ingredientId: cod,
      quantity: '500',
      addedOn: ymd(addDays(new Date(), -20)),
    });
    const plan = await createPlan(today, tomorrow);
    const slotId = plan.slotsByDateAndOccasion.get(`${tomorrow}|Dinner`);
    if (slotId === undefined) throw new Error('missing Dinner slot');
    await assignRecipeToSlot({ slotId, recipeId: pie.id, numberOfServings: 1 });

    await page.goto(`/plans/${String(plan.id)}/shopping`);
    const line = page.locator(`[data-ingredient-id="${String(cod)}"]`);
    await line.getByRole('button', { name: /Cod: In freezer: 500 g/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Cod' });
    await sheet.getByRole('button', { name: 'Use 400 g from storage' }).click();
    await expect(sheet).toBeHidden();
    await expect(line.getByText('From storage')).toBeVisible();
    await expect(line.getByRole('checkbox')).toHaveCount(0);

    await page.goto('/storage?location=freezer');
    await expect(
      page
        .getByRole('region', { name: 'Ingredients' })
        .getByText('500 g, 400 g reserved'),
    ).toBeVisible();

    await getPool().query(
      `update stock_reservations set needed_on = current_date - 1`,
    );
    await page.reload();
    await expect(
      page
        .getByRole('region', { name: 'Ingredients' })
        .getByText('100 g', { exact: true }),
    ).toBeVisible();
  });

  // Manual verification step 2.
  test('restocks a running-low Staple on a tick, and puts it back on an untick', async ({
    page,
  }) => {
    await createIngredient({
      name: 'Olive oil',
      unit: 'ml',
      category: 'Pantry',
    });
    const today = ymd(new Date());
    const plan = await createPlan(today, ymd(addDays(new Date(), 1)));

    await page.goto('/storage?location=pantry');
    await page.getByLabel('Add a Staple to the pantry').fill('olive');
    await page.getByRole('option', { name: /Olive oil/i }).click();
    const staples = page.getByRole('region', { name: 'Staples' });
    const oil = staples.getByRole('radiogroup', {
      name: /Olive oil: how much you have/i,
    });
    await expect(oil).toBeVisible();
    await oil.getByRole('radio', { name: 'Running low' }).click();
    await expect(
      oil.getByRole('radio', { name: 'Running low' }),
    ).toHaveAttribute('aria-checked', 'true');

    await page.goto(`/plans/${String(plan.id)}/shopping`);
    const restock = page.locator('[data-shopping-staples-restock]');
    await expect(restock).toContainText('Olive oil');
    await expect(restock).toContainText('Pantry');
    const tick = restock.getByRole('checkbox', { name: /Olive oil/i });
    await tick.click();
    await expect(tick).toBeChecked();
    await expect.poll(stapleState).toBe('in_stock');

    await page.goto('/storage?location=pantry');
    await expect(oil.getByRole('radio', { name: 'In stock' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    await page.goto(`/plans/${String(plan.id)}/shopping`);
    await restock.getByRole('checkbox', { name: /Olive oil/i }).click();
    await expect.poll(stapleState).toBe('running_low');
    await page.goto('/storage?location=pantry');
    await expect(
      oil.getByRole('radio', { name: 'Running low' }),
    ).toHaveAttribute('aria-checked', 'true');
  });
});

async function stapleState(): Promise<string | undefined> {
  const { rows } = await getPool().query<{ staple_state: string }>(
    `select staple_state from ingredients where lower(name) = 'olive oil'`,
  );
  return rows[0]?.staple_state;
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
