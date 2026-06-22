import { expect, test } from '@playwright/test';

import {
  assignRecipeToSlot,
  createPlan,
  createRecipe,
  resetHouseholdData,
  setCooksBaseOnSlot,
} from '../fixtures/db.ts';

// Drive the planner via the API/DB layer (the planner UI's DnD path is
// `lg+` only — DEC-84/85 — so authoring through DnD would be flaky on the
// default Playwright viewport). We seed a base recipe + a batch-version
// recipe, create a plan, attach the base cook to an earlier slot and the
// batch-version meal to a later slot, then verify the planner renders both
// references correctly.
test.describe('planner with base + batch-version recipes', () => {
  test.beforeEach(async () => {
    await resetHouseholdData();
  });

  test('renders the base cook line and the batch-version meal', async ({
    page,
  }) => {
    // A "Curry base" recipe is_base=true with two ingredients.
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

    // A batch-version meal that *uses* the base. Its own ingredients are the
    // toppings unique to the batch portion (so the shopping list can prove
    // the no-double-count rule on test 4).
    const batchMeal = await createRecipe({
      name: 'Chicken curry (batch portion)',
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

    // A plan starting today gives us "today's planner view" without dealing
    // with the date-range search params. Two-day range so Mon = base cook,
    // Tue = batch meal.
    const today = new Date();
    const start = formatYmd(today);
    const end = formatYmd(addDays(today, 1));
    const plan = await createPlan(start, end);

    // Earlier slot: base cook only — slot stays empty (no meal), but
    // contributes ingredients via cooks-base.
    const baseSlotId = plan.slotsByDateAndOccasion.get(`${start}|Lunch`);
    if (baseSlotId === undefined) throw new Error('missing base slot');
    await setCooksBaseOnSlot({
      slotId: baseSlotId,
      cooksBaseRecipeId: base.id,
      cooksBaseServings: base.baseServings,
    });

    // Later slot: the batch-version meal.
    const batchSlotId = plan.slotsByDateAndOccasion.get(`${end}|Dinner`);
    if (batchSlotId === undefined) throw new Error('missing batch slot');
    await assignRecipeToSlot({
      slotId: batchSlotId,
      recipeId: batchMeal.id,
      numberOfServings: batchMeal.baseServings,
    });

    await page.goto(`/plans/${String(plan.id)}`);

    // The earlier slot renders the "Cook base: …" line because cooks-base is
    // set even though the slot itself is empty.
    const baseSlot = page.locator(`[data-slot-id="${String(baseSlotId)}"]`);
    await expect(baseSlot).toBeVisible();
    await expect(baseSlot).toContainText('Cook base: Curry base');
    await expect(baseSlot).toContainText('×8');

    // The later slot shows the batch-version meal name.
    const batchSlot = page.locator(`[data-slot-id="${String(batchSlotId)}"]`);
    await expect(batchSlot).toBeVisible();
    await expect(batchSlot).toHaveAttribute('data-slot-type', 'recipe');
    await expect(batchSlot).toContainText('Chicken curry (batch portion)');
  });
});

function formatYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}
