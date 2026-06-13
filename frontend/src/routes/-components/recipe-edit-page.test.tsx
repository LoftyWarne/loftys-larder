import type { Recipe } from '@loftys-larder/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  recipeGetUseQueryMock,
  referencesUseQueryMock,
  credentialsUseQueryMock,
  ingredientsListFetchMock,
  recipeGetInvalidateMock,
  updateHeaderMutateAsyncMock,
  replaceIngredientsMutateAsyncMock,
  replaceMethodMutateAsyncMock,
  updateHeaderUseMutationMock,
  replaceIngredientsUseMutationMock,
  replaceMethodUseMutationMock,
  useParamsMock,
} = vi.hoisted(() => ({
  recipeGetUseQueryMock: vi.fn(),
  referencesUseQueryMock: vi.fn(),
  credentialsUseQueryMock: vi.fn(),
  ingredientsListFetchMock: vi.fn(),
  recipeGetInvalidateMock: vi.fn(),
  updateHeaderMutateAsyncMock: vi.fn(),
  replaceIngredientsMutateAsyncMock: vi.fn(),
  replaceMethodMutateAsyncMock: vi.fn(),
  updateHeaderUseMutationMock: vi.fn(),
  replaceIngredientsUseMutationMock: vi.fn(),
  replaceMethodUseMutationMock: vi.fn(),
  useParamsMock: vi.fn(),
}));

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    useUtils: () => ({
      recipes: { get: { invalidate: recipeGetInvalidateMock } },
      ingredients: { list: { fetch: ingredientsListFetchMock } },
    }),
    recipes: {
      get: { useQuery: recipeGetUseQueryMock },
      references: { useQuery: referencesUseQueryMock },
      updateHeader: { useMutation: updateHeaderUseMutationMock },
      replaceIngredients: { useMutation: replaceIngredientsUseMutationMock },
      replaceMethod: { useMutation: replaceMethodUseMutationMock },
    },
    uploads: {
      getRecipeImageCredentials: { useQuery: credentialsUseQueryMock },
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
      params,
      ...rest
    }: {
      children: React.ReactNode;
      to: string;
      params?: Record<string, string>;
      [key: string]: unknown;
    }) => {
      const path = params
        ? to.replace(/\$(\w+)/g, (_, key: string) => params[key] ?? '')
        : to;
      return (
        <a href={path} {...rest}>
          {children}
        </a>
      );
    },
    useParams: useParamsMock,
  };
});

import { RecipeEditPage } from './recipe-edit-page.tsx';

const RECIPE: Recipe = {
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
  ingredients: [],
  method: [],
  averageRating: null,
  ratingCount: 0,
  yourRating: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  useParamsMock.mockReturnValue({ recipeId: '7' });
  recipeGetUseQueryMock.mockReturnValue({
    data: RECIPE,
    isLoading: false,
    error: null,
  });
  referencesUseQueryMock.mockReturnValue({
    data: { units: [], prepTypes: [], sources: [] },
    isLoading: false,
    error: null,
  });
  credentialsUseQueryMock.mockReturnValue({
    refetch: vi.fn(),
  });
  updateHeaderUseMutationMock.mockReturnValue({
    mutateAsync: updateHeaderMutateAsyncMock,
  });
  replaceIngredientsUseMutationMock.mockReturnValue({
    mutateAsync: replaceIngredientsMutateAsyncMock,
  });
  replaceMethodUseMutationMock.mockReturnValue({
    mutateAsync: replaceMethodMutateAsyncMock,
  });
  recipeGetInvalidateMock.mockResolvedValue(undefined);
});

describe('RecipeEditPage', () => {
  it('renders the editor when the recipe loads', () => {
    render(<RecipeEditPage />);
    expect(
      screen.getByRole('heading', { name: /editing onion soup/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Save details' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Save ingredients' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Save method' }),
    ).toBeInTheDocument();
  });

  it('sends only the changed field on header save', async () => {
    updateHeaderMutateAsyncMock.mockResolvedValue({ id: 7 });
    const user = userEvent.setup();
    render(<RecipeEditPage />);

    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Renamed soup');
    await user.click(screen.getByRole('button', { name: 'Save details' }));

    await waitFor(() => {
      expect(updateHeaderMutateAsyncMock).toHaveBeenCalledTimes(1);
    });
    expect(updateHeaderMutateAsyncMock.mock.calls[0]?.[0]).toEqual({
      id: 7,
      patch: { name: 'Renamed soup' },
    });
    expect(replaceIngredientsMutateAsyncMock).not.toHaveBeenCalled();
    expect(replaceMethodMutateAsyncMock).not.toHaveBeenCalled();
  });

  it('renders the saved notice and invalidates the get query on header save', async () => {
    updateHeaderMutateAsyncMock.mockResolvedValue({ id: 7 });
    const user = userEvent.setup();
    render(<RecipeEditPage />);

    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Renamed soup');
    await user.click(screen.getByRole('button', { name: 'Save details' }));

    await waitFor(() => {
      expect(recipeGetInvalidateMock).toHaveBeenCalledWith({ id: 7 });
    });
    expect(screen.getByRole('status')).toHaveTextContent('Saved.');
  });

  it('shows NOT_FOUND when the route param is non-positive', () => {
    useParamsMock.mockReturnValue({ recipeId: '0' });
    render(<RecipeEditPage />);
    expect(
      screen.getByRole('heading', { name: /recipe not found/i }),
    ).toBeInTheDocument();
  });

  it('keeps other sections enabled when one section save fails', async () => {
    updateHeaderMutateAsyncMock.mockRejectedValue(new Error('header boom'));
    const user = userEvent.setup();
    render(<RecipeEditPage />);

    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'X');
    await user.click(screen.getByRole('button', { name: 'Save details' }));

    expect(await screen.findByText('header boom')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Save ingredients' }),
    ).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save method' })).toBeEnabled();
  });
});
