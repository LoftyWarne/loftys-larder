import type { Recipe } from '@loftys-larder/shared';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TRPCClientError } from '@trpc/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WakeLockStatus } from '@/hooks/use-wake-lock.ts';

const {
  getUseQueryMock,
  useParamsMock,
  useSearchMock,
  navigateMock,
  wakeLockMock,
} = vi.hoisted(() => ({
  getUseQueryMock: vi.fn(),
  useParamsMock: vi.fn(),
  useSearchMock: vi.fn(),
  navigateMock: vi.fn(),
  wakeLockMock: vi.fn<() => WakeLockStatus>(),
}));

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    recipes: {
      get: { useQuery: getUseQueryMock },
    },
  },
}));

vi.mock('@/hooks/use-wake-lock.ts', () => ({
  useWakeLock: wakeLockMock,
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    className,
  }: {
    children: React.ReactNode;
    to: string;
    className?: string;
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useParams: useParamsMock,
  useSearch: useSearchMock,
  useNavigate: () => navigateMock,
}));

import { cookSearchSchema } from '@loftys-larder/shared';
import { CookModePage } from './cook-mode-page.tsx';

const RECIPE: Recipe = {
  id: 7,
  name: 'Onion Soup',
  description: null,
  imageUrl: null,
  baseServings: 2,
  activeTimeMins: null,
  totalTimeMins: null,
  estimatedCostPerServing: null,
  sourceId: null,
  sourceName: null,
  sourceUrl: null,
  sourceDetail: null,
  caloriesPerServing: null,
  proteinPerServing: null,
  carbsPerServing: null,
  fatPerServing: null,
  saturatedFatPerServing: null,
  fibrePerServing: null,
  sugarPerServing: null,
  saltPerServing: null,
  nutritionIsEstimated: false,
  addedByUserId: null,
  isBase: false,
  baseRecipeId: null,
  baseRecipeName: null,
  baseRecipeIsDeleted: null,
  isDeleted: false,
  plantPointsCount: 1,
  healthScore: null,
  ingredients: [
    {
      id: 1,
      ingredientId: 100,
      ingredientName: 'Onion',
      quantity: '300.000',
      unitId: 10,
      unitName: 'g',
      prepTypeId: 1,
      prepTypeName: 'chopped',
      isPlant: true,
      isOptional: false,
    },
    {
      id: 2,
      ingredientId: 200,
      ingredientName: 'Butter',
      quantity: '50.000',
      unitId: 10,
      unitName: 'g',
      prepTypeId: null,
      prepTypeName: null,
      isPlant: false,
      isOptional: false,
    },
  ],
  method: [
    {
      id: 11,
      stepNumber: 1,
      instruction: 'Melt the butter and soften the onions.',
      safetyNote: 'The pan gets hot.',
      tip: 'Go slowly.',
      prepAhead: null,
      ingredients: [
        { ingredientId: 100, quantity: null },
        { ingredientId: 200, quantity: '50.000' },
      ],
    },
    {
      id: 12,
      stepNumber: 2,
      instruction: 'Add 500 g of stock and simmer.',
      safetyNote: null,
      tip: null,
      prepAhead: null,
      ingredients: [],
    },
  ],
  averageRating: null,
  ratingCount: 0,
  tags: [],
  yourRating: null,
  originals: [],
};

type SearchFn = (prev: { servings?: number; step?: number }) => unknown;

function lastNavigation(): { search?: SearchFn; replace?: boolean } & Record<
  string,
  unknown
> {
  const call = navigateMock.mock.calls.at(-1) as
    | [{ search?: SearchFn; replace?: boolean } & Record<string, unknown>]
    | undefined;
  if (!call) throw new Error('navigate was not called');
  return call[0];
}

function renderAt(
  search: { servings?: number; step?: number },
  recipe = RECIPE,
) {
  useSearchMock.mockReturnValue(search);
  getUseQueryMock.mockReturnValue({
    data: recipe,
    isLoading: false,
    error: null,
  });
  return render(<CookModePage />);
}

beforeEach(() => {
  getUseQueryMock.mockReset();
  useParamsMock.mockReset();
  useParamsMock.mockReturnValue({ recipeId: '7' });
  useSearchMock.mockReset();
  navigateMock.mockReset();
  wakeLockMock.mockReset();
  wakeLockMock.mockReturnValue('held');
});

describe('cookSearchSchema', () => {
  it('keeps a valid step and servings', () => {
    expect(cookSearchSchema.parse({ servings: 4, step: 3 })).toEqual({
      servings: 4,
      step: 3,
    });
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['text', 'two'],
  ])('drops a %s step rather than failing', (_label, step) => {
    expect(cookSearchSchema.parse({ step })).toEqual({ step: undefined });
  });

  it("drops servings the recipe page wouldn't accept", () => {
    expect(cookSearchSchema.parse({ servings: 51, step: 1 })).toEqual({
      servings: undefined,
      step: 1,
    });
  });
});

describe('CookModePage', () => {
  describe('gather screen', () => {
    it('opens on the gather screen with the scaled ingredients and Start', () => {
      renderAt({ servings: 4 });

      expect(
        screen.getByRole('heading', { name: /gather ingredients/i }),
      ).toBeInTheDocument();
      const list = screen.getByRole('list', { name: 'Ingredients' });
      expect(within(list).getByText(/600 g/)).toBeInTheDocument();
      expect(within(list).getByText(/100 g/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled();
      expect(screen.getByTestId('cook-next-preview')).toHaveTextContent(
        'Next: Melt the butter and soften the onions.',
      );
    });

    it('keeps ticks while moving between screens, and loses them on reload', async () => {
      const user = userEvent.setup();
      const { rerender, unmount } = renderAt({});

      await user.click(screen.getByRole('checkbox', { name: /onion/i }));
      expect(screen.getByRole('checkbox', { name: /onion/i })).toBeChecked();

      useSearchMock.mockReturnValue({ step: 1 });
      rerender(<CookModePage />);
      useSearchMock.mockReturnValue({});
      rerender(<CookModePage />);
      expect(screen.getByRole('checkbox', { name: /onion/i })).toBeChecked();

      unmount();
      renderAt({});
      expect(
        screen.getByRole('checkbox', { name: /onion/i }),
      ).not.toBeChecked();
    });

    it('never blocks Start on unticked ingredients', async () => {
      const user = userEvent.setup();
      renderAt({});

      await user.click(screen.getByRole('button', { name: 'Start' }));

      const nav = lastNavigation();
      expect(nav.replace).toBe(true);
      expect(nav.search?.({})).toEqual({ servings: undefined, step: 1 });
    });

    it('says when a recipe has no ingredients', () => {
      renderAt({}, { ...RECIPE, ingredients: [] });
      expect(
        screen.getByText('This recipe has no ingredients.'),
      ).toBeInTheDocument();
    });

    it('notes when the screen may sleep, and only then', () => {
      wakeLockMock.mockReturnValue('unavailable');
      const { unmount } = renderAt({});
      expect(
        screen.getByText('This browser may let the screen sleep.'),
      ).toBeInTheDocument();
      unmount();

      wakeLockMock.mockReturnValue('held');
      renderAt({});
      expect(
        screen.queryByText('This browser may let the screen sleep.'),
      ).not.toBeInTheDocument();
    });
  });

  describe('step screens', () => {
    it('shows one step large with its chips and notes', () => {
      renderAt({ step: 1 });

      expect(
        screen.getByRole('heading', { name: /step 1 of 2/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/and soften the/).parentElement,
      ).toHaveTextContent('Melt the butter and soften the onions.');
      expect(screen.getByText(/and soften the/).parentElement).toHaveClass(
        'text-2xl',
      );
      expect(screen.getByTestId('cook-next-preview')).toHaveTextContent(
        'Next: Add 500 g of stock and simmer.',
      );
      const chips = screen.getByRole('list', { name: 'Step 1 ingredients' });
      expect(within(chips).getByText('Onion')).toBeInTheDocument();
      expect(within(chips).getByText(/50 g/)).toBeInTheDocument();
      expect(screen.getByRole('note', { name: 'Safety' })).toBeInTheDocument();
      expect(screen.getByRole('note', { name: 'Tip' })).toBeInTheDocument();
    });

    it('scales chips with the servings', () => {
      renderAt({ step: 1, servings: 4 });
      const chips = screen.getByRole('list', { name: 'Step 1 ingredients' });
      expect(within(chips).getByText(/100 g/)).toBeInTheDocument();
    });

    it('notes that amounts in the step are for the original servings when scaled', () => {
      const { unmount } = renderAt({ step: 2, servings: 4 });
      expect(
        screen.getByText(
          'Amounts written in this step are for the original 2 servings.',
        ),
      ).toBeInTheDocument();
      unmount();

      renderAt({ step: 2 });
      expect(
        screen.queryByText(/are for the original/),
      ).not.toBeInTheDocument();
    });

    it('moves with Next and Back, replacing history and keeping servings', async () => {
      const user = userEvent.setup();
      renderAt({ step: 1, servings: 4 });

      await user.click(screen.getByRole('button', { name: 'Next' }));
      let nav = lastNavigation();
      expect(nav.replace).toBe(true);
      expect(nav.search?.({ servings: 4, step: 1 })).toEqual({
        servings: 4,
        step: 2,
      });

      await user.click(screen.getByRole('button', { name: 'Back' }));
      nav = lastNavigation();
      expect(nav.replace).toBe(true);
      expect(nav.search?.({ servings: 4, step: 1 })).toEqual({ servings: 4 });
    });

    it('finishes on the last step back to the recipe page at the same servings', async () => {
      const user = userEvent.setup();
      renderAt({ step: 2, servings: 4 });

      expect(screen.queryByTestId('cook-next-preview')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Finish' }));

      expect(lastNavigation()).toMatchObject({
        to: '/recipes/$recipeId',
        params: { recipeId: '7' },
        search: { servings: 4 },
        replace: true,
      });
    });

    it('shows the last step for a step past the end', () => {
      renderAt({ step: 9 });
      expect(
        screen.getByRole('heading', { name: /step 2 of 2/i }),
      ).toBeInTheDocument();
    });

    it('moves with the arrow keys', async () => {
      const user = userEvent.setup();
      renderAt({ step: 1 });

      await user.keyboard('{ArrowRight}');
      expect(lastNavigation().search?.({ step: 1 })).toEqual({
        servings: undefined,
        step: 2,
      });

      await user.keyboard('{ArrowLeft}');
      expect(lastNavigation().search?.({ step: 1 })).toEqual({
        servings: undefined,
      });
    });

    it('moves focus to the step heading when the step changes', () => {
      const { rerender } = renderAt({ step: 1 });
      useSearchMock.mockReturnValue({ step: 2 });
      act(() => {
        rerender(<CookModePage />);
      });
      expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
    });
  });

  describe('step list', () => {
    it('lists every screen and jumps to the one chosen', async () => {
      const user = userEvent.setup();
      renderAt({ step: 1 });

      await user.click(screen.getByRole('button', { name: /step 1 of 2/i }));
      const dialog = screen.getByRole('dialog', { name: 'Steps' });
      const options = within(dialog)
        .getAllByRole('button')
        .filter((button) => button.textContent !== 'Close');
      expect(options.map((option) => option.textContent)).toEqual([
        'Gather ingredients',
        '1. Melt the butter and soften the onions.',
        '2. Add 500 g of stock and simmer.',
      ]);
      expect(options[1]).toHaveAttribute('aria-current', 'step');

      await user.click(
        within(dialog).getByRole('button', {
          name: '2. Add 500 g of stock and simmer.',
        }),
      );
      expect(lastNavigation().search?.({ step: 1 })).toEqual({
        servings: undefined,
        step: 2,
      });
    });
  });

  it('offers Exit back to the recipe page', () => {
    renderAt({ step: 1 });
    expect(screen.getByRole('link', { name: 'Exit' })).toHaveAttribute(
      'href',
      '/recipes/$recipeId',
    );
  });

  it('shows a not-found state when the recipe does not exist', () => {
    useSearchMock.mockReturnValue({});
    const err = new TRPCClientError<never>('not found');
    Object.assign(err, { data: { code: 'NOT_FOUND' } });
    getUseQueryMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: err,
    });
    render(<CookModePage />);
    expect(
      screen.getByRole('heading', { name: 'Recipe not found' }),
    ).toBeInTheDocument();
  });
});
