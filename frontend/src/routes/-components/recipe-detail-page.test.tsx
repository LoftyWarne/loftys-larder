import type { Recipe } from '@loftys-larder/shared';
import { render, screen } from '@testing-library/react';
import { TRPCClientError } from '@trpc/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getUseQueryMock, useParamsMock } = vi.hoisted(() => ({
  getUseQueryMock: vi.fn(),
  useParamsMock: vi.fn(),
}));

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    recipes: {
      get: { useQuery: getUseQueryMock },
    },
  },
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
  pairedRecipeId: null,
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
    },
  ],
  method: [
    { id: 1, stepNumber: 1, instruction: 'Sauté onions.' },
    { id: 2, stepNumber: 2, instruction: 'Simmer.' },
  ],
  averageRating: null,
  ratingCount: 0,
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
});
