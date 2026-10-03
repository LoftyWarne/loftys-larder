import type { Recipe } from '@loftys-larder/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TRPCClientError } from '@trpc/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getUseQueryMock, useParamsMock, useSearchMock, navigateMock } =
  vi.hoisted(() => ({
    getUseQueryMock: vi.fn(),
    useParamsMock: vi.fn(),
    useSearchMock: vi.fn(),
    navigateMock: vi.fn(),
  }));

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    recipes: {
      get: { useQuery: getUseQueryMock },
    },
  },
}));

vi.mock('@/components/recipe-rating.tsx', () => ({
  RecipeRating: ({
    recipeId,
    yourRating,
    isDisabled,
  }: {
    recipeId: number;
    yourRating: number | null;
    isDisabled?: boolean;
  }) => (
    <div
      data-testid="recipe-rating-mock"
      data-recipe-id={String(recipeId)}
      data-your-rating={yourRating === null ? 'null' : String(yourRating)}
      data-disabled={isDisabled ? 'true' : 'false'}
    />
  ),
}));

vi.mock('@/components/recipe-comments.tsx', () => ({
  RecipeComments: ({ recipeId }: { recipeId: number }) => (
    <div data-testid="recipe-comments-mock" data-recipe-id={String(recipeId)} />
  ),
}));

vi.mock('@/components/related-recipes.tsx', () => ({
  RelatedRecipes: ({
    recipeId,
    isDisabled,
  }: {
    recipeId: number;
    isDisabled?: boolean;
  }) => (
    <div
      data-testid="related-recipes-mock"
      data-recipe-id={String(recipeId)}
      data-disabled={isDisabled ? 'true' : 'false'}
    />
  ),
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>(
    '@tanstack/react-router',
  );
  return {
    ...actual,
    Link: ({
      children,
      to,
      ...rest
    }: {
      children: React.ReactNode;
      to: string;
      [key: string]: unknown;
    }) => (
      <a href={to} {...rest}>
        {children}
      </a>
    ),
    useParams: useParamsMock,
    useSearch: useSearchMock,
    useNavigate: () => navigateMock,
  };
});

import { RecipeDetailPage } from './recipe-detail-page.tsx';

const FULL_RECIPE: Recipe = {
  id: 7,
  name: 'Onion Soup',
  description: 'A simple soup.',
  imageUrl: null,
  baseServings: 2,
  activeTimeMins: 10,
  totalTimeMins: 25,
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
  addedByUserId: null,
  isBase: false,
  baseRecipeId: null,
  baseRecipeName: null,
  baseRecipeIsDeleted: null,
  isDeleted: false,
  plantPointsCount: 1,
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
      id: 1,
      stepNumber: 1,
      instruction: 'Sauté onions.',
      safetyNote: null,
      tip: null,
      prepAhead: null,
      ingredients: [],
    },
    {
      id: 2,
      stepNumber: 2,
      instruction: 'Simmer.',
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
};

function makeNotFoundError(): TRPCClientError<never> {
  const err = new TRPCClientError<never>('not found');
  Object.assign(err, { data: { code: 'NOT_FOUND' } });
  return err;
}

beforeEach(() => {
  getUseQueryMock.mockReset();
  useParamsMock.mockReset();
  useParamsMock.mockReturnValue({ recipeId: '7' });
  useSearchMock.mockReset();
  useSearchMock.mockReturnValue({});
  navigateMock.mockReset();
});

describe('RecipeDetailPage', () => {
  it('renders the recipe header, ingredients, and method in order', () => {
    getUseQueryMock.mockReturnValue({
      data: FULL_RECIPE,
      isLoading: false,
      error: null,
    });
    render(<RecipeDetailPage />);

    expect(
      screen.getByRole('heading', { name: 'Onion Soup' }),
    ).toBeInTheDocument();
    expect(screen.getByText('A simple soup.')).toBeInTheDocument();
    expect(screen.getByText('Onion')).toBeInTheDocument();
    expect(screen.getByText(/, chopped/)).toBeInTheDocument();
    const methodItems = screen
      .getByRole('heading', { name: /method/i })
      .parentElement?.querySelectorAll('ol li');
    expect(methodItems?.[0]).toHaveTextContent('Sauté onions.');
    expect(methodItems?.[1]).toHaveTextContent('Simmer.');
  });

  it('labels optional ingredients', () => {
    getUseQueryMock.mockReturnValue({
      data: {
        ...FULL_RECIPE,
        ingredients: FULL_RECIPE.ingredients.map((line) =>
          line.ingredientName === 'Butter'
            ? { ...line, isOptional: true }
            : line,
        ),
      },
      isLoading: false,
      error: null,
    });
    render(<RecipeDetailPage />);

    const items = screen
      .getByRole('heading', { name: /ingredients/i })
      .closest('section')
      ?.querySelectorAll('ul li');
    expect(items?.[0]).not.toHaveTextContent('(optional)');
    expect(items?.[1]).toHaveTextContent('Butter (optional)');
  });

  it('renders step notes as labelled callouts, safety before tip', () => {
    getUseQueryMock.mockReturnValue({
      data: {
        ...FULL_RECIPE,
        method: [
          {
            ...FULL_RECIPE.method[0],
            safetyNote: 'Hot pan.',
            tip: 'Low and slow.',
          },
          FULL_RECIPE.method[1],
        ],
      },
      isLoading: false,
      error: null,
    });
    render(<RecipeDetailPage />);

    const notes = screen.getAllByRole('note');
    expect(notes).toHaveLength(2);
    expect(notes[0]).toHaveAccessibleName('Safety');
    expect(notes[0]).toHaveTextContent('Hot pan.');
    expect(notes[1]).toHaveAccessibleName('Tip');
    expect(notes[1]).toHaveTextContent('Low and slow.');

    const methodItems = screen
      .getByRole('heading', { name: /method/i })
      .parentElement?.querySelectorAll('ol li');
    expect(methodItems?.[0]).toContainElement(notes[0] ?? null);
    expect(methodItems?.[1]?.querySelector('[role="note"]')).toBeNull();
  });

  it('bolds ingredients, quantities, times and temperatures in step text', () => {
    getUseQueryMock.mockReturnValue({
      data: {
        ...FULL_RECIPE,
        method: [
          {
            ...FULL_RECIPE.method[0],
            instruction: 'Fry the onions in 50g butter at 180°C for 5 mins.',
          },
          FULL_RECIPE.method[1],
        ],
      },
      isLoading: false,
      error: null,
    });
    render(<RecipeDetailPage />);

    const methodItems = screen
      .getByRole('heading', { name: /method/i })
      .parentElement?.querySelectorAll('ol li');
    const bold = [...(methodItems?.[0]?.querySelectorAll('strong') ?? [])].map(
      (element) => element.textContent,
    );
    expect(bold).toEqual(['onions', '50g', 'butter', '180°C', '5 mins']);
    expect(methodItems?.[0]).toHaveTextContent(
      'Fry the onions in 50g butter at 180°C for 5 mins.',
    );
    expect(methodItems?.[1]?.querySelector('strong')).toBeNull();
  });

  it('shows the source name with its detail and links to the URL', () => {
    getUseQueryMock.mockReturnValue({
      data: {
        ...FULL_RECIPE,
        sourceName: 'Ottolenghi Simple',
        sourceUrl: 'https://example.test/recipe',
        sourceDetail: 'p.142',
      },
      isLoading: false,
      error: null,
    });
    render(<RecipeDetailPage />);

    const link = screen.getByRole('link', { name: 'Ottolenghi Simple' });
    expect(link).toHaveAttribute('href', 'https://example.test/recipe');
    expect(screen.getByText(/p\.142/)).toBeInTheDocument();
  });

  it('marks the recipe as a base recipe when isBase is true', () => {
    getUseQueryMock.mockReturnValue({
      data: { ...FULL_RECIPE, isBase: true },
      isLoading: false,
      error: null,
    });
    render(<RecipeDetailPage />);

    expect(screen.getByText('Base recipe')).toBeInTheDocument();
  });

  it('does not show the base recipe badge for a non-base recipe', () => {
    getUseQueryMock.mockReturnValue({
      data: FULL_RECIPE,
      isLoading: false,
      error: null,
    });
    render(<RecipeDetailPage />);

    expect(screen.queryByText('Base recipe')).not.toBeInTheDocument();
  });

  it('shows a not-found state when the get query returns NOT_FOUND', () => {
    getUseQueryMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: makeNotFoundError(),
    });
    render(<RecipeDetailPage />);
    expect(
      screen.getByRole('heading', { name: /recipe not found/i }),
    ).toBeInTheDocument();
  });

  it('shows a loading state while the query resolves', () => {
    getUseQueryMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });
    render(<RecipeDetailPage />);
    expect(screen.getByRole('status')).toHaveTextContent(/loading recipe/i);
  });

  it('shows a not-found state when the route param is not a positive integer', () => {
    useParamsMock.mockReturnValue({ recipeId: 'abc' });
    getUseQueryMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
    });
    render(<RecipeDetailPage />);
    expect(
      screen.getByRole('heading', { name: /recipe not found/i }),
    ).toBeInTheDocument();
  });

  it('renders the rating widget and hides the average summary when no ratings', () => {
    getUseQueryMock.mockReturnValue({
      data: FULL_RECIPE,
      isLoading: false,
      error: null,
    });
    render(<RecipeDetailPage />);
    const widget = screen.getByTestId('recipe-rating-mock');
    expect(widget).toHaveAttribute('data-recipe-id', '7');
    expect(widget).toHaveAttribute('data-your-rating', 'null');
    expect(widget).toHaveAttribute('data-disabled', 'false');
    expect(screen.queryByLabelText(/average rating/i)).not.toBeInTheDocument();
  });

  it('lists the recipe’s tags and omits the list when there are none', () => {
    getUseQueryMock.mockReturnValue({
      data: { ...FULL_RECIPE, tags: [{ id: 1, name: 'Weeknight' }] },
      isLoading: false,
      error: null,
    });
    const { unmount } = render(<RecipeDetailPage />);
    expect(screen.getByRole('list', { name: 'Tags' })).toHaveTextContent(
      'Weeknight',
    );
    unmount();

    getUseQueryMock.mockReturnValue({
      data: FULL_RECIPE,
      isLoading: false,
      error: null,
    });
    render(<RecipeDetailPage />);
    expect(screen.queryByRole('list', { name: 'Tags' })).toBeNull();
  });

  it('renders the average summary when there is at least one rating', () => {
    getUseQueryMock.mockReturnValue({
      data: { ...FULL_RECIPE, averageRating: 4.25, ratingCount: 4 },
      isLoading: false,
      error: null,
    });
    render(<RecipeDetailPage />);
    const summary = screen.getByLabelText(/average rating/i);
    expect(summary).toHaveTextContent('4.3');
    expect(summary).toHaveTextContent('(4)');
  });

  it('disables the rating widget on a soft-deleted recipe', () => {
    getUseQueryMock.mockReturnValue({
      data: { ...FULL_RECIPE, isDeleted: true },
      isLoading: false,
      error: null,
    });
    render(<RecipeDetailPage />);
    expect(screen.getByTestId('recipe-rating-mock')).toHaveAttribute(
      'data-disabled',
      'true',
    );
  });

  describe('plan ahead', () => {
    it('omits the Plan ahead section when no step is marked', () => {
      getUseQueryMock.mockReturnValue({
        data: FULL_RECIPE,
        isLoading: false,
        error: null,
      });
      render(<RecipeDetailPage />);

      expect(
        screen.queryByRole('heading', { name: 'Plan ahead' }),
      ).not.toBeInTheDocument();
    });

    it('lists must-do steps before can-do steps, above the method', () => {
      getUseQueryMock.mockReturnValue({
        data: {
          ...FULL_RECIPE,
          method: [
            {
              id: 1,
              stepNumber: 1,
              instruction: 'Make the stock.',
              safetyNote: null,
              tip: null,
              prepAhead: 'optional',
              ingredients: [],
            },
            {
              id: 2,
              stepNumber: 2,
              instruction: 'Marinate overnight.',
              safetyNote: null,
              tip: null,
              prepAhead: 'required',
              ingredients: [],
            },
            {
              id: 3,
              stepNumber: 3,
              instruction: 'Grill.',
              safetyNote: null,
              tip: null,
              prepAhead: null,
              ingredients: [],
            },
          ],
        },
        isLoading: false,
        error: null,
      });
      render(<RecipeDetailPage />);

      const heading = screen.getByRole('heading', { name: 'Plan ahead' });
      const methodHeading = screen.getByRole('heading', { name: /method/i });
      expect(
        heading.compareDocumentPosition(methodHeading) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      const groups = within(
        screen.getByRole('region', { name: 'Plan ahead' }),
      ).getAllByRole('group');
      expect(groups).toHaveLength(2);
      expect(groups[0]).toHaveAccessibleName('Must be done ahead');
      expect(groups[0]).toHaveTextContent('Step 2: Marinate overnight.');
      expect(groups[1]).toHaveAccessibleName('Can be done ahead');
      expect(groups[1]).toHaveTextContent('Step 1: Make the stock.');
      expect(groups[1]).not.toHaveTextContent('Grill.');
    });

    it('badges marked steps in the method list', () => {
      getUseQueryMock.mockReturnValue({
        data: {
          ...FULL_RECIPE,
          method: [
            { ...FULL_RECIPE.method[0], prepAhead: 'required' },
            FULL_RECIPE.method[1],
          ],
        },
        isLoading: false,
        error: null,
      });
      render(<RecipeDetailPage />);

      const methodItems = screen
        .getByRole('heading', { name: /method/i })
        .parentElement?.querySelectorAll('ol li');
      expect(methodItems?.[0]).toHaveTextContent('Must be done ahead');
      expect(methodItems?.[1]).not.toHaveTextContent('done ahead');
    });
  });
  describe('portions', () => {
    function renderRecipe(
      recipe: Recipe = FULL_RECIPE,
      search: { servings?: number } = {},
    ): void {
      useSearchMock.mockReturnValue(search);
      getUseQueryMock.mockReturnValue({
        data: recipe,
        isLoading: false,
        error: null,
      });
      render(<RecipeDetailPage />);
    }

    function ingredientTexts(): string[] {
      const items =
        screen
          .getByRole('heading', { name: /ingredients/i })
          .closest('section')
          ?.querySelectorAll('ul li') ?? [];
      return [...items].map((item) => item.textContent);
    }

    it("shows the recipe's own servings by default, with no reset", () => {
      renderRecipe();

      const stepper = screen.getByRole('group', { name: 'Servings' });
      expect(stepper).toHaveTextContent('2');
      expect(screen.queryByRole('button', { name: /reset/i })).toBeNull();
      expect(ingredientTexts()).toEqual([
        '300 g Onion, chopped',
        '50 g Butter',
      ]);
    });

    it('scales ingredient amounts to the servings in the URL', () => {
      renderRecipe(FULL_RECIPE, { servings: 3 });

      expect(screen.getByRole('group', { name: 'Servings' })).toHaveTextContent(
        '3',
      );
      expect(ingredientTexts()).toEqual([
        '450 g Onion, chopped',
        '75 g Butter',
      ]);
      expect(
        screen.getByRole('button', { name: 'Reset to 2' }),
      ).toBeInTheDocument();
    });

    // The page navigates with a search updater so each tap applies to the
    // URL as it is at that moment; run the last one against a given URL.
    function lastSearchFrom(prev: { servings?: number }): unknown {
      const options = navigateMock.mock.lastCall?.[0] as {
        search: (prev: { servings?: number }) => unknown;
      };
      return options.search(prev);
    }

    it('changes servings through the URL, replacing history and keeping scroll', async () => {
      const user = userEvent.setup();
      renderRecipe(FULL_RECIPE, { servings: 4 });

      await user.click(screen.getByRole('button', { name: 'More servings' }));
      expect(navigateMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          from: '/recipes/$recipeId/',
          replace: true,
          resetScroll: false,
        }),
      );
      expect(lastSearchFrom({ servings: 4 })).toEqual({ servings: 5 });

      await user.click(screen.getByRole('button', { name: 'Fewer servings' }));
      expect(lastSearchFrom({ servings: 4 })).toEqual({ servings: 3 });

      await user.click(screen.getByRole('button', { name: 'Reset to 2' }));
      expect(lastSearchFrom({ servings: 4 })).toEqual({});
    });

    it('applies each step to the latest URL, so a double-click adds two servings', async () => {
      const user = userEvent.setup();
      renderRecipe();

      await user.dblClick(
        screen.getByRole('button', { name: 'More servings' }),
      );

      const updaters = navigateMock.mock.calls.map(
        ([options]) =>
          (options as { search: (prev: { servings?: number }) => unknown })
            .search,
      );
      expect(updaters).toHaveLength(2);
      const afterFirst = updaters[0]?.({}) as { servings?: number };
      expect(updaters[1]?.(afterFirst)).toEqual({ servings: 4 });
    });

    it("clears the URL param when stepping back to the recipe's own servings", async () => {
      const user = userEvent.setup();
      renderRecipe(FULL_RECIPE, { servings: 3 });

      await user.click(screen.getByRole('button', { name: 'Fewer servings' }));
      expect(lastSearchFrom({ servings: 3 })).toEqual({});
    });

    it('keeps a stepped value within 1 and the maximum', async () => {
      const user = userEvent.setup();
      renderRecipe(FULL_RECIPE, { servings: 3 });

      await user.click(screen.getByRole('button', { name: 'More servings' }));
      expect(lastSearchFrom({ servings: 50 })).toEqual({ servings: 50 });
      await user.click(screen.getByRole('button', { name: 'Fewer servings' }));
      expect(lastSearchFrom({ servings: 1 })).toEqual({ servings: 1 });
    });

    it('stops at one serving', () => {
      renderRecipe(FULL_RECIPE, { servings: 1 });
      expect(
        screen.getByRole('button', { name: 'Fewer servings' }),
      ).toBeDisabled();
    });

    it('stops at the maximum', () => {
      renderRecipe(FULL_RECIPE, { servings: 50 });
      expect(
        screen.getByRole('button', { name: 'More servings' }),
      ).toBeDisabled();
    });

    describe('step ingredients', () => {
      const WITH_LINKS: Recipe = {
        ...FULL_RECIPE,
        method: [
          {
            ...FULL_RECIPE.method[0],
            instruction: 'Sauté the onions in some of the butter.',
            ingredients: [
              { ingredientId: 200, quantity: '20.000' },
              { ingredientId: 100, quantity: null },
            ],
          },
          {
            ...FULL_RECIPE.method[1],
            instruction: 'Stir in the rest of the butter.',
            ingredients: [{ ingredientId: 200, quantity: null }],
          },
        ],
      } as Recipe;

      function chipTexts(stepNumber: number): string[] {
        const list = screen.getByRole('list', {
          name: `Step ${String(stepNumber)} ingredients`,
        });
        return [...list.querySelectorAll('li')].map((item) => item.textContent);
      }

      it("lists each step's ingredients in ingredient-list order, with what's left for a blank amount", () => {
        renderRecipe(WITH_LINKS);

        expect(chipTexts(1)).toEqual(['300 g Onion', '20 g Butter']);
        expect(chipTexts(2)).toEqual(['30 g Butter']);
      });

      it('scales chip amounts with the servings', () => {
        renderRecipe(WITH_LINKS, { servings: 4 });

        expect(chipTexts(1)).toEqual(['600 g Onion', '40 g Butter']);
        expect(chipTexts(2)).toEqual(['60 g Butter']);
      });

      it('omits the chip list for a step with no ingredients', () => {
        renderRecipe();
        expect(
          screen.queryByRole('list', { name: 'Step 1 ingredients' }),
        ).toBeNull();
      });
    });

    describe('amounts written in step text', () => {
      const STATES_AMOUNT: Recipe = {
        ...FULL_RECIPE,
        method: [
          {
            ...FULL_RECIPE.method[0],
            instruction: 'Fry the onions in 50 g butter.',
          },
          FULL_RECIPE.method[1],
        ],
      } as Recipe;
      const NOTE =
        /amounts written in the steps are for the original 2 servings/i;

      function boldInFirstStep(): string[] {
        const step = screen
          .getByRole('heading', { name: /method/i })
          .parentElement?.querySelector('ol > li');
        return [...(step?.querySelectorAll('strong') ?? [])].map(
          (element) => element.textContent,
        );
      }

      it('bolds them and adds no note at the original servings', () => {
        renderRecipe(STATES_AMOUNT);

        expect(screen.queryByText(NOTE)).toBeNull();
        expect(boldInFirstStep()).toContain('50 g');
      });

      it('notes they are for the original servings, and drops their bold, when scaled', () => {
        renderRecipe(STATES_AMOUNT, { servings: 4 });

        expect(screen.getByText(NOTE)).toBeInTheDocument();
        expect(boldInFirstStep()).toEqual(['onions', 'butter']);
      });

      it('adds no note when scaled but no step states an amount', () => {
        renderRecipe(FULL_RECIPE, { servings: 4 });
        expect(screen.queryByText(NOTE)).toBeNull();
      });
    });
  });
});
