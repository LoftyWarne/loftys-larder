import { expect, test, type Page } from '@playwright/test';

import {
  assignRecipeToSlot,
  createPlan,
  createRecipe,
  createStockItem,
  getPool,
  resetHouseholdData,
} from '../fixtures/db.ts';

test.describe('eating from storage', () => {
  test.beforeEach(async () => {
    await resetHouseholdData();
  });

  // Manual verification step 1. e2e can't move the clock, so "the day after"
  // is the Reservation's day moved into the past.
  test('eats a frozen lasagne as Leftovers from Storage, and it leaves the Freezer after the day', async ({
    page,
  }) => {
    const lasagne = await createRecipe({
      name: 'Lasagne',
      baseServings: 4,
      ingredients: [
        { name: 'Beef mince', quantity: '500', unit: 'g', category: 'Meat' },
      ],
    });
    await createStockItem({
      location: 'freezer',
      recipeId: lasagne.id,
      quantity: '2',
      addedOn: ymd(addDays(new Date(), -14)),
    });
    const today = ymd(new Date());
    const tomorrow = ymd(addDays(new Date(), 1));
    const plan = await createPlan(today, tomorrow);
    const slotId = plan.slotsByDateAndOccasion.get(`${tomorrow}|Dinner`);
    if (slotId === undefined) throw new Error('missing Dinner slot');

    await page.goto(`/plans/${String(plan.id)}`);
    const card = page.locator(`[data-slot-id="${String(slotId)}"]`);
    // An empty slot isn't draggable, so its button is aria-disabled for the
    // drag; a tap still opens the editor.
    await card
      .getByRole('button', { name: new RegExp(`^Dinner on ${tomorrow}`) })
      .click({ force: true });
    await page.getByLabel('Number of guests').fill('2');
    await page.getByText('Leftovers', { exact: true }).click();
    await page.getByLabel('Leftovers of which meal').selectOption({
      label: '❄ Lasagne — Freezer · frozen 2 weeks ago · 2 portions free',
    });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(card.getByTestId('leftovers-label')).toHaveText(
      'Leftovers from storage',
    );
    await expect(card.getByTestId('slot-item-shortfall')).toHaveCount(0);

    await expectFreezerDishes(page, '2 portions, 2 reserved');

    await getPool().query(
      `update stock_reservations set needed_on = current_date - 1`,
    );
    await page.reload();
    await expect(
      page.getByRole('region', { name: 'Dishes' }).getByText('Lasagne'),
    ).toHaveCount(0);
  });

  // Manual verification step 2.
  test('cooks a stew Variation from its frozen base, buying only its own ingredients', async ({
    page,
  }) => {
    const base = await createRecipe({
      name: 'Beef stew base',
      baseServings: 4,
      isBase: true,
      ingredients: [
        {
          name: 'Braising steak',
          quantity: '800',
          unit: 'g',
          category: 'Meat',
        },
      ],
    });
    const pie = await createRecipe({
      name: 'Stew pie',
      baseServings: 2,
      baseRecipeId: base.id,
      ingredients: [
        {
          name: 'Puff pastry',
          quantity: '320',
          unit: 'g',
          category: 'Bakery',
        },
      ],
    });
    await createStockItem({
      location: 'freezer',
      recipeId: base.id,
      quantity: '2',
      addedOn: ymd(addDays(new Date(), -30)),
    });
    const today = ymd(new Date());
    const tomorrow = ymd(addDays(new Date(), 1));
    const plan = await createPlan(today, tomorrow);
    const slotId = plan.slotsByDateAndOccasion.get(`${tomorrow}|Dinner`);
    if (slotId === undefined) throw new Error('missing Dinner slot');
    await assignRecipeToSlot({ slotId, recipeId: pie.id, numberOfServings: 2 });

    await page.goto(`/plans/${String(plan.id)}`);
    const card = page.locator(`[data-slot-id="${String(slotId)}"]`);
    await expect(card.getByTestId('slot-item-shortfall')).toBeVisible();

    await card
      .getByRole('button', { name: new RegExp(`^Dinner on ${tomorrow}`) })
      .click();
    await page.getByRole('checkbox', { name: /Use frozen base/ }).check();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(card.getByText(/base from storage/)).toBeVisible();
    await expect(card.getByTestId('slot-item-shortfall')).toHaveCount(0);

    await page.goto(`/plans/${String(plan.id)}/shopping`);
    await expect(page.getByText('Puff pastry')).toBeVisible();
    await expect(page.getByText('Braising steak')).toHaveCount(0);

    await expectFreezerDishes(page, '2 portions, 2 reserved');
  });
});

async function expectFreezerDishes(page: Page, text: string): Promise<void> {
  await page.goto('/storage?location=freezer');
  await expect(
    page
      .getByRole('region', { name: 'Dishes' })
      .getByText(text, { exact: true }),
  ).toBeVisible();
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
