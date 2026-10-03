import { expect, test } from '@playwright/test';

import {
  assignRecipeToSlot,
  createPlan,
  createRecipe,
  resetHouseholdData,
} from '../fixtures/db.ts';

// A planner dish opens its recipe scaled to the portions being cooked
// (DEC-98), and each method step lists the ingredients it uses (DEC-99).
test.describe('recipe portions and step ingredients', () => {
  test.beforeEach(async () => {
    await resetHouseholdData();
  });

  test('a planner dish opens at the portions cooked, and the stepper rescales', async ({
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
      .getByRole('link', { name: 'Buttered carrots' })
      .click();

    await expect(page).toHaveURL(
      new RegExp(`/recipes/${String(recipe.id)}\\?servings=4$`),
    );
    const ingredients = page.getByRole('region', { name: 'Ingredients' });
    await expect(ingredients).toContainText('8 piece Carrot');
    await expect(ingredients).toContainText('100 g Butter');
    await expect(
      page.getByRole('list', { name: 'Step 1 ingredients' }),
    ).toHaveText('40 g Butter');
    await expect(
      page.getByRole('list', { name: 'Step 2 ingredients' }),
    ).toHaveText(/8 piece Carrot\s*60 g Butter/);
    await expect(
      page.getByText(
        'Amounts written in the steps are for the original 2 servings.',
      ),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Reset to 2' }).click();
    await expect(page).toHaveURL(new RegExp(`/recipes/${String(recipe.id)}$`));
    await expect(
      page.getByRole('list', { name: 'Step 2 ingredients' }),
    ).toHaveText(/4 piece Carrot\s*30 g Butter/);
    await expect(
      page.getByText('Amounts written in the steps are for the original'),
    ).toBeHidden();

    await page.getByRole('button', { name: 'More servings' }).click();
    await expect(page).toHaveURL(/\?servings=3$/);
    await expect(ingredients).toContainText('6 piece Carrot');
  });

  test("the editor fills a new step's ingredients from its text and saves them", async ({
    page,
  }) => {
    const recipe = await createRecipe({
      name: 'Garlic butter',
      baseServings: 2,
      ingredients: [
        { name: 'Butter', quantity: '50', unit: 'g', category: 'Dairy' },
        {
          name: 'Garlic',
          quantity: '2',
          unit: 'piece',
          category: 'Fruit & Veg',
        },
      ],
    });

    await page.goto(`/recipes/${String(recipe.id)}/edit`);
    await page.getByRole('button', { name: 'Add step' }).click();
    await page
      .getByLabel('Step 1 text')
      .fill('Melt 30 g butter with the garlic.');
    await expect(page.getByLabel('Step 1 Butter amount')).toHaveValue('30');
    await expect(page.getByLabel('Step 1 Garlic amount')).toHaveValue('');

    await page.getByRole('button', { name: 'Save method' }).click();
    await expect(
      page.getByRole('form', { name: 'Method' }).getByRole('status'),
    ).toHaveText('Saved.');

    await page.goto(`/recipes/${String(recipe.id)}`);
    await expect(
      page.getByRole('list', { name: 'Step 1 ingredients' }),
    ).toHaveText(/30 g Butter\s*2 piece Garlic/);
  });
});
