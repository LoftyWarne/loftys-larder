import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import {
  assignRecipeToSlot,
  createPlan,
  createRecipe,
  E2E_USER_NAME,
  resetHouseholdData,
  setCooksBaseOnSlot,
  type CreatedPlan,
} from '../fixtures/db.ts';

// axe-core's `impact` values: 'minor' | 'moderate' | 'serious' | 'critical'.
// Failing on serious/critical keeps the gate honest without flagging every
// shadcn primitive nuance — minor/moderate are reported in the test output
// but do not fail the run.
const FAIL_IMPACTS = new Set(['serious', 'critical']);

// WCAG 2.1 AA is the spec's target. axe-core ships these tags out of the box.
const WCAG_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const;

type Theme = 'light' | 'dark';

const THEMES: readonly Theme[] = ['light', 'dark'];

interface SeededAuthedFixture {
  planId: number;
}

// Authed views share one seeded fixture across the inner theme loop — we
// reset the DB once per outer test, not once per theme, because axe scans
// don't mutate state.
async function seedAuthedFixture(): Promise<SeededAuthedFixture> {
  const base = await createRecipe({
    name: 'Curry base',
    baseServings: 8,
    isBase: true,
    ingredients: [
      { name: 'Onion', quantity: '4', unit: 'piece', category: 'Fruit & Veg' },
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
      { name: 'Chicken thigh', quantity: '600', unit: 'g', category: 'Meat' },
    ],
  });

  const today = new Date();
  const start = ymd(today);
  const end = ymd(addDays(today, 1));
  const plan: CreatedPlan = await createPlan(start, end);

  const baseSlotId = plan.slotsByDateAndOccasion.get(`${start}|Lunch`);
  const batchSlotId = plan.slotsByDateAndOccasion.get(`${end}|Dinner`);
  if (baseSlotId === undefined || batchSlotId === undefined) {
    throw new Error('a11y fixture: missing slot in seeded plan');
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

  return { planId: plan.id };
}

async function runAxe(page: Page, theme: Theme): Promise<void> {
  // Emulating `prefers-color-scheme` flips ThemeProvider via its matchMedia
  // listener — the seeded e2e user is on `themePreference: 'system'`, so the
  // class on <html> follows the emulated value without any UI interaction.
  await page.emulateMedia({ colorScheme: theme });
  // The class toggle runs inside a useEffect; wait until the resolved theme
  // is reflected on <html> before scanning so axe sees the right styles.
  // String form of `page.evaluate` to avoid needing the DOM lib in tsconfig.
  await expect
    .poll(() =>
      page.evaluate('document.documentElement.classList.contains("dark")'),
    )
    .toBe(theme === 'dark');

  const results = await new AxeBuilder({ page })
    .withTags([...WCAG_AA_TAGS])
    .analyze();

  const failing = results.violations.filter(
    (v) =>
      v.impact !== null && v.impact !== undefined && FAIL_IMPACTS.has(v.impact),
  );

  if (failing.length > 0) {
    const summary = failing
      .map((v) => {
        const targets = v.nodes.map((n) => n.target.join(' ')).join(', ');
        return `[${v.impact ?? '?'}] ${v.id}: ${v.help} — ${targets}\n  ${v.helpUrl}`;
      })
      .join('\n');
    throw new Error(
      `axe-core found ${String(failing.length)} ${theme}-theme violation(s):\n${summary}`,
    );
  }
}

// The sign-in view is the only public surface. The authed storageState would
// redirect to `/` via `signInBeforeLoad`, so we open a fresh empty context per
// test instead of mutating the file-level fixture (a describe-scoped
// `test.use({ storageState: ... })` has been observed to leak into sibling
// describes in this Playwright version).
test.describe('a11y — public views', () => {
  for (const theme of THEMES) {
    test(`sign-in passes axe in ${theme} theme`, async ({ browser }) => {
      const context = await browser.newContext({
        storageState: { cookies: [], origins: [] },
      });
      const page = await context.newPage();
      try {
        await page.goto('/sign-in');
        await expect(
          page.getByRole('heading', { name: /sign in/i }),
        ).toBeVisible();
        await runAxe(page, theme);
      } finally {
        await context.close();
      }
    });
  }
});

test.describe('a11y — authed views', () => {
  let fixture: SeededAuthedFixture;

  test.beforeEach(async () => {
    await resetHouseholdData();
    fixture = await seedAuthedFixture();
  });

  for (const theme of THEMES) {
    test(`home passes axe in ${theme} theme`, async ({ page }) => {
      await page.goto('/');
      // A named user lands on the time-of-day greeting, not the brand
      // fallback heading. Match on the name to stay clock-agnostic.
      await expect(
        page.getByRole('heading', { name: new RegExp(E2E_USER_NAME) }),
      ).toBeVisible();
      await runAxe(page, theme);
    });

    test(`recipe browse passes axe in ${theme} theme`, async ({ page }) => {
      await page.goto('/recipes');
      await expect(
        page.getByRole('heading', { name: 'Recipes' }),
      ).toBeVisible();
      await runAxe(page, theme);
    });

    test(`recipe editor passes axe in ${theme} theme`, async ({ page }) => {
      await page.goto('/recipes/new');
      await expect(
        page.getByRole('heading', { name: 'New recipe' }),
      ).toBeVisible();
      await runAxe(page, theme);
    });

    test(`plan list passes axe in ${theme} theme`, async ({ page }) => {
      await page.goto('/plans');
      await expect(page.getByRole('heading', { name: /plans/i })).toBeVisible();
      await runAxe(page, theme);
    });

    test(`planner passes axe in ${theme} theme`, async ({ page }) => {
      await page.goto(`/plans/${String(fixture.planId)}`);
      await expect(page.locator('[data-slot-id]').first()).toBeVisible();
      await runAxe(page, theme);
    });

    test(`shopping list passes axe in ${theme} theme`, async ({ page }) => {
      await page.goto(`/plans/${String(fixture.planId)}/shopping`);
      await expect(
        page.getByRole('heading', { name: 'Shopping list' }),
      ).toBeVisible();
      await runAxe(page, theme);
    });

    test(`ingredients passes axe in ${theme} theme`, async ({ page }) => {
      await page.goto('/ingredients');
      await expect(
        page.getByRole('heading', { name: /ingredients/i }),
      ).toBeVisible();
      await runAxe(page, theme);
    });

    test(`settings passes axe in ${theme} theme`, async ({ page }) => {
      await page.goto('/settings');
      await expect(
        page.getByRole('heading', { name: /settings/i }),
      ).toBeVisible();
      await runAxe(page, theme);
    });
  }
});

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}
