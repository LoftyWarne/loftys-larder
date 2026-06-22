import { expect, test } from '@playwright/test';

import {
  assignRecipeToSlot,
  createPlan,
  createRecipe,
  resetHouseholdData,
  setCooksBaseOnSlot,
} from '../fixtures/db.ts';

// The shopping-list aggregation is the highest-value domain math we test in
// e2e. Fixture: a base recipe with Onion + Tomato passata; a batch-version
// meal whose own ingredient is Chicken thigh only. Earlier slot cooks the
// base; later slot eats the batch portion. The aggregation rule (no double
// count for the base's ingredients on the meal path) means the shopping list
// should show:
//   Onion: 4 piece (from base cook only — NOT also via the batch meal slot)
//   Tomato passata: 800 g
//   Chicken thigh: 600 g
// If the no-double-count rule were broken, Onion / Tomato passata would also
// show contributions from the batch meal slot.
test.describe('shopping list math respects the no-double-count rule', () => {
  test.beforeEach(async () => {
    await resetHouseholdData();
  });

  test('lines aggregate base ingredients only via cooks-base, not via the batch meal slot', async ({
    page,
  }) => {
    const base = await createRecipe({
      name: 'Curry base',
      baseServings: 8,
      isBase: true,
      ingredients: [
        {
          name: 'Onion',
          quantity: '4',
          unit: 'piece',
          category: 'Fruit & Veg',
        },
        {
          name: 'Tomato passata',
          quantity: '800',
          unit: 'g',
          category: 'Pantry',
        },
      ],
    });

    const batchMeal = await createRecipe({
      name: 'Chicken curry batch',
      baseServings: 4,
      baseRecipeId: base.id,
      ingredients: [
        {
          name: 'Chicken thigh',
          quantity: '600',
          unit: 'g',
          category: 'Meat',
        },
      ],
    });

    const today = new Date();
    const start = formatYmd(today);
    const end = formatYmd(addDays(today, 1));
    const plan = await createPlan(start, end);

    const baseSlotId = plan.slotsByDateAndOccasion.get(`${start}|Lunch`);
    const batchSlotId = plan.slotsByDateAndOccasion.get(`${end}|Dinner`);
    if (baseSlotId === undefined || batchSlotId === undefined) {
      throw new Error('missing slot in fixture');
    }
    await setCooksBaseOnSlot({
      slotId: baseSlotId,
      cooksBaseRecipeId: base.id,
      cooksBaseServings: base.baseServings,
    });
    await assignRecipeToSlot({
      slotId: batchSlotId,
      recipeId: batchMeal.id,
      numberOfServings: batchMeal.baseServings,
    });

    await page.goto(`/plans/${String(plan.id)}/shopping`);
    await expect(
      page.getByRole('heading', { name: 'Shopping list' }),
    ).toBeVisible();

    const onionLine = lineFor(page, 'Onion');
    await expect(onionLine).toBeVisible();
    await expect(onionLine.locator('[data-shopping-total]')).toHaveText(
      '4 piece',
    );
    // Onion comes from exactly one slot — the base-cook slot. If the meal
    // path were also pulling base ingredients, the count would be 2.
    await expect(
      onionLine.locator('[data-shopping-contributors] summary'),
    ).toHaveText('From 1 meal');

    const passataLine = lineFor(page, 'Tomato passata');
    await expect(passataLine.locator('[data-shopping-total]')).toHaveText(
      '800 g',
    );
    await expect(
      passataLine.locator('[data-shopping-contributors] summary'),
    ).toHaveText('From 1 meal');

    const chickenLine = lineFor(page, 'Chicken thigh');
    await expect(chickenLine.locator('[data-shopping-total]')).toHaveText(
      '600 g',
    );
    await expect(
      chickenLine.locator('[data-shopping-contributors] summary'),
    ).toHaveText('From 1 meal');
  });
});

function lineFor(
  page: import('@playwright/test').Page,
  ingredientName: string,
) {
  // The line wraps the ingredient name in a span; targeting by visible text
  // inside the `[data-shopping-line]` parent is stable across category groups.
  return page
    .locator('[data-shopping-line]')
    .filter({ hasText: ingredientName });
}

function formatYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}
