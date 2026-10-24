import { expect, test } from '@playwright/test';

import {
  assignRecipeToSlot,
  createPlan,
  createRecipe,
  resetHouseholdData,
} from '../fixtures/db.ts';

// Cook mode (DEC-116): a planner dish opens it at the portions being cooked,
// with a gather screen first, then one method step per screen.
test.describe('cook mode', () => {
  test.beforeEach(async () => {
    await resetHouseholdData();
  });

  test('a planner dish opens cook mode, which walks through the recipe and finishes on its page', async ({
    page,
  }) => {
    const recipe = await createRecipe({
      name: 'Buttered carrots',
      baseServings: 2,
      ingredients: [
        {
          name: 'Carrot',
          quantity: '4',
          unit: 'piece',
          category: 'Fruit & Veg',
        },
        { name: 'Butter', quantity: '50', unit: 'g', category: 'Dairy' },
      ],
      method: [
        {
          instruction: 'Melt 20 g of the butter.',
          ingredients: [{ name: 'Butter', quantity: '20' }],
        },
        {
          instruction: 'Toss the carrots in the rest of the butter.',
          ingredients: [{ name: 'Carrot' }, { name: 'Butter' }],
        },
      ],
    });
    const today = new Date().toISOString().slice(0, 10);
    const plan = await createPlan(today, today);
    const slotId = plan.slotsByDateAndOccasion.get(`${today}|Dinner`);
    if (slotId === undefined) throw new Error('missing dinner slot');
    await assignRecipeToSlot({
      slotId,
      recipeId: recipe.id,
      numberOfServings: 4,
    });

    await page.goto(`/plans/${String(plan.id)}`);
    await page
      .locator(`[data-slot-id="${String(slotId)}"]`)
      .getByRole('link', { name: 'Cook Buttered carrots' })
      .click();

    const cookPath = `/recipes/${String(recipe.id)}/cook`;
    await expect(page).toHaveURL(new RegExp(`${cookPath}\\?servings=4$`));
    await expect(
      page.getByRole('heading', { name: 'Gather ingredients' }),
    ).toBeVisible();
    // The app's own navigation gives way to cook mode's.
    await expect(
      page.getByRole('link', { name: 'Shopping list' }),
    ).toBeHidden();
    const ingredients = page.getByRole('list', { name: 'Ingredients' });
    await expect(ingredients).toContainText('8 piece Carrot');
    await expect(ingredients).toContainText('100 g Butter');
    await page.getByRole('checkbox', { name: /Carrot/ }).check();

    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page).toHaveURL(/\?servings=4&step=1$/);
    await expect(
      page.getByRole('heading', { name: 'Step 1 of 2' }),
    ).toBeVisible();
    await expect(
      page.getByRole('list', { name: 'Step 1 ingredients' }),
    ).toHaveText('40 g Butter');
    await expect(page.getByTestId('cook-next-preview')).toHaveText(
      'Next: Toss the carrots in the rest of the butter.',
    );

    await page.getByRole('button', { name: 'Next' }).click();
    await expect(
      page.getByRole('list', { name: 'Step 2 ingredients' }),
    ).toHaveText(/8 piece Carrot\s*60 g Butter/);

    // The step list jumps back to the gather screen; the tick is still there.
    await page.getByRole('button', { name: 'Step 2 of 2' }).click();
    await page
      .getByRole('dialog', { name: 'Steps' })
      .getByRole('button', { name: 'Gather ingredients' })
      .click();
    await expect(page).toHaveURL(new RegExp(`${cookPath}\\?servings=4$`));
    await expect(page.getByRole('checkbox', { name: /Carrot/ })).toBeChecked();

    // A reload keeps the step and drops the ticks.
    await page.goto(`${cookPath}?servings=4&step=2`);
    await expect(
      page.getByRole('heading', { name: 'Step 2 of 2' }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Finish' }).click();
    await expect(page).toHaveURL(
      new RegExp(`/recipes/${String(recipe.id)}\\?servings=4$`),
    );
    await expect(
      page.getByRole('heading', { name: 'Buttered carrots' }),
    ).toBeVisible();
  });

  test('moving between steps replaces history, so Back leaves cook mode', async ({
    page,
  }) => {
    const recipe = await createRecipe({
      name: 'Toast',
      baseServings: 1,
      ingredients: [
        { name: 'Bread', quantity: '1', unit: 'piece', category: 'Bakery' },
      ],
      method: [
        { instruction: 'Toast the bread.', ingredients: [] },
        { instruction: 'Eat it.', ingredients: [] },
      ],
    });

    await page.goto(`/recipes/${String(recipe.id)}`);
    await page.getByRole('link', { name: 'Start cooking' }).click();
    await page.getByRole('button', { name: 'Start' }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(
      page.getByRole('heading', { name: 'Step 2 of 2' }),
    ).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/recipes/${String(recipe.id)}$`));
    await page.goForward();
    await expect(
      page.getByRole('heading', { name: 'Step 2 of 2' }),
    ).toBeVisible();
  });
});
