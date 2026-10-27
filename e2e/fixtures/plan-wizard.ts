import { expect, type Page } from '@playwright/test';

import { createRecipe } from './db.ts';

// Shared by the wizard spec and its axe scans. The e2e backend runs the
// `fake` meal planner, which fills open slots from the library in order.

const DAY_MS = 24 * 60 * 60 * 1000;

// Far enough ahead to clear any plan the other specs create.
function civilDate(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * DAY_MS).toISOString().slice(0, 10);
}

export const WIZARD_START = civilDate(60);
export const WIZARD_END = civilDate(61);

// The fake planner refuses a Brief carrying its refusal marker.
export const FAKE_REFUSED_BRIEF = 'Anything [fake:refused]';

export async function seedWizardRecipes(): Promise<void> {
  for (const name of ['Lentil Soup', 'Bean Chilli', 'Fish Pie']) {
    await createRecipe({
      name,
      baseServings: 4,
      ingredients: [
        {
          name: 'Red lentils',
          quantity: '200',
          unit: 'g',
          category: 'Pantry',
        },
      ],
    });
  }
}

export async function openBriefStep(page: Page): Promise<void> {
  await page.goto('/plans/propose');
  await page.getByLabel('Start date').fill(WIZARD_START);
  await page.getByLabel('End date').fill(WIZARD_END);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(
    page.getByRole('heading', { name: 'Who’s eating?' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(
    page.getByRole('heading', { name: 'Any meals already decided?' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(
    page.getByRole('heading', { name: 'Anything to steer the plan?' }),
  ).toBeVisible();
}

export async function openPlanReview(
  page: Page,
  brief = 'Something warming',
): Promise<void> {
  await openBriefStep(page);
  await page.getByLabel('Brief').fill(brief);
  await page.getByRole('button', { name: 'Plan my meals' }).click();
  await expect(page.getByRole('heading', { name: /^Review/ })).toBeVisible();
}
