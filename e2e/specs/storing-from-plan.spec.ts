import { expect, test, type Page } from '@playwright/test';

import {
  assignRecipeToSlot,
  createPlan,
  createRecipe,
  getPool,
  resetHouseholdData,
} from '../fixtures/db.ts';

test.describe('storing portions from the plan', () => {
  test.beforeEach(async () => {
    await resetHouseholdData();
  });

  // Manual verification step 1, all on one day: e2e can't move the clock to
  // "the next day", and storing works the same on any day.
  test('freezes, adds more, takes some back and keeps one in the fridge', async ({
    page,
  }) => {
    const chilli = await createRecipe({
      name: 'Chilli',
      baseServings: 8,
      ingredients: [
        { name: 'Beef mince', quantity: '500', unit: 'g', category: 'Meat' },
      ],
    });
    const today = ymd(new Date());
    const plan = await createPlan(today, ymd(addDays(new Date(), 1)));
    const slotId = plan.slotsByDateAndOccasion.get(`${today}|Dinner`);
    if (slotId === undefined) throw new Error('missing Dinner slot');
    await assignRecipeToSlot({
      slotId,
      recipeId: chilli.id,
      numberOfServings: 2,
    });
    await getPool().query(
      'update meal_plan_slot_items set prepared = 8 where slot_id = $1',
      [slotId],
    );

    await page.goto(`/plans/${String(plan.id)}`);
    const card = page.locator(`[data-slot-id="${String(slotId)}"]`);

    // Plan time: Prepare 8, Eat 2, Freeze 2 leaves 4 in the plan.
    await card
      .getByRole('button', { name: new RegExp(`^Dinner on ${today}`) })
      .click();
    await page.getByLabel('Frozen for Chilli').fill('2');
    await expect(page.getByTestId('base-remaining')).toHaveText(
      '(4 left in plan)',
    );
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(card.getByText('×2 +4 · 2 frozen')).toBeVisible();
    await expectFreezerPortions(page, '2 portions');

    // Later: store 2 more from the card.
    await page.goto(`/plans/${String(plan.id)}`);
    await card.getByRole('button', { name: 'Store Chilli…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Store Chilli' });
    const freezer = dialog.getByRole('group', { name: 'Freezer' });
    // Opens at the current count; the first raise adds the plan's 4 leftovers.
    await expect(freezer).toContainText('2 portions');
    await freezer.getByRole('button', { name: 'More in the Freezer' }).click();
    await expect(freezer).toContainText('6 portions');
    await freezer.getByRole('button', { name: 'Fewer in the Freezer' }).click();
    await freezer.getByRole('button', { name: 'Fewer in the Freezer' }).click();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    await expect(card.getByText('×2 +2 · 4 frozen')).toBeVisible();
    await expectFreezerPortions(page, '4 portions');

    // Lower Freeze to 3 in the editor.
    await page.goto(`/plans/${String(plan.id)}`);
    await card
      .getByRole('button', { name: new RegExp(`^Dinner on ${today}`) })
      .click();
    await page.getByLabel('Frozen for Chilli').fill('3');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(card.getByText('×2 +3 · 3 frozen')).toBeVisible();
    await expectFreezerPortions(page, '3 portions');

    // Keep 1 in the Fridge, use by three days from today.
    await page.goto(`/plans/${String(plan.id)}`);
    await card.getByRole('button', { name: 'Store Chilli…' }).click();
    await expect(freezer).toContainText('3 portions');
    const fridge = dialog.getByRole('group', { name: 'Fridge' });
    // The first raise adds the plan's 3 leftovers; take 2 back off.
    await fridge.getByRole('button', { name: 'More in the Fridge' }).click();
    await expect(fridge).toContainText('3 portions');
    await fridge.getByRole('button', { name: 'Fewer in the Fridge' }).click();
    await fridge.getByRole('button', { name: 'Fewer in the Fridge' }).click();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    await expect(
      card.getByText('×2 +2 · 3 frozen · 1 in fridge'),
    ).toBeVisible();

    await page.goto('/storage?location=fridge');
    const dishes = page.getByRole('region', { name: 'Dishes' });
    await expect(dishes.getByText('1 portion', { exact: true })).toBeVisible();
    const { rows } = await getPool().query<{ use_by: string }>(
      `select to_char(use_by, 'YYYY-MM-DD') as use_by
       from stock_items where location = 'fridge'`,
    );
    expect(rows.map((row) => row.use_by)).toEqual([
      ymd(addDays(new Date(), 3)),
    ]);
  });
});

async function expectFreezerPortions(page: Page, text: string): Promise<void> {
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
