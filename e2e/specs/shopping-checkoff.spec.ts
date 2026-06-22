import { expect, test } from '@playwright/test';

import {
  assignRecipeToSlot,
  createPlan,
  createRecipe,
  resetHouseholdData,
} from '../fixtures/db.ts';

// Tap items off, reload the page, and assert the state persisted. Uses a
// minimal fixture (one meal, two ingredients) so the check-off interaction
// is the unambiguous variable.
test.describe('shopping list check-off persists across reload', () => {
  test.beforeEach(async () => {
    await resetHouseholdData();
  });

  test('ticked lines stay ticked after a full reload', async ({ page }) => {
    const meal = await createRecipe({
      name: 'Scrambled eggs',
      baseServings: 2,
      ingredients: [
        { name: 'Egg', quantity: '4', unit: 'piece', category: 'Dairy' },
        { name: 'Butter', quantity: '20', unit: 'g', category: 'Dairy' },
      ],
    });

    const today = new Date();
    const start = formatYmd(today);
    const plan = await createPlan(start, start);
    const slotId = plan.slotsByDateAndOccasion.get(`${start}|Lunch`);
    if (slotId === undefined) throw new Error('missing slot');
    await assignRecipeToSlot({
      slotId,
      recipeId: meal.id,
      numberOfServings: meal.baseServings,
    });

    await page.goto(`/plans/${String(plan.id)}/shopping`);
    await expect(
      page.getByRole('heading', { name: 'Shopping list' }),
    ).toBeVisible();

    // Tick the Egg line. The Radix Checkbox primitive accepts a click on the
    // checkbox itself; the aria-label flips to "Mark Egg as not bought" after.
    const eggCheckbox = page.getByRole('checkbox', {
      name: /Mark Egg as bought/,
    });
    await eggCheckbox.click();
    await expect(
      page.getByRole('checkbox', { name: /Mark Egg as not bought/ }),
    ).toBeVisible();

    // Butter stays unticked — gives us a regression signal if the persistence
    // bug were to flip *every* line.
    await expect(
      page.getByRole('checkbox', { name: /Mark Butter as bought/ }),
    ).toBeVisible();

    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Shopping list' }),
    ).toBeVisible();

    await expect(
      page.getByRole('checkbox', { name: /Mark Egg as not bought/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('checkbox', { name: /Mark Butter as bought/ }),
    ).toBeVisible();
  });
});

function formatYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
