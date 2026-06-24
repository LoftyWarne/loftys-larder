import type { Recipe } from '@loftys-larder/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  recipeGetUseQueryMock,
  referencesUseQueryMock,
  credentialsUseQueryMock,
  ingredientsListFetchMock,
  recipesListFetchMock,
  recipeGetInvalidateMock,
  updateHeaderMutateAsyncMock,
  replaceIngredientsMutateAsyncMock,
  replaceMethodMutateAsyncMock,
  setBatchFieldsMutateAsyncMock,
  updateHeaderUseMutationMock,
  replaceIngredientsUseMutationMock,
  replaceMethodUseMutationMock,
  setBatchFieldsUseMutationMock,
  draftGetForRecipeUseQueryMock,
  draftGetNewDraftsUseQueryMock,
  draftUpsertMutateMock,
  draftDeleteMutateMock,
  draftGetForRecipeInvalidateMock,
  draftGetNewDraftsInvalidateMock,
  useParamsMock,
  navigateMock,
  useLocationMock,
} = vi.hoisted(() => ({
  recipeGetUseQueryMock: vi.fn(),
  referencesUseQueryMock: vi.fn(),
  credentialsUseQueryMock: vi.fn(),
  ingredientsListFetchMock: vi.fn(),
  recipesListFetchMock: vi.fn(),
  recipeGetInvalidateMock: vi.fn(),
  updateHeaderMutateAsyncMock: vi.fn(),
  replaceIngredientsMutateAsyncMock: vi.fn(),
  replaceMethodMutateAsyncMock: vi.fn(),
  setBatchFieldsMutateAsyncMock: vi.fn(),
  updateHeaderUseMutationMock: vi.fn(),
  replaceIngredientsUseMutationMock: vi.fn(),
  replaceMethodUseMutationMock: vi.fn(),
  setBatchFieldsUseMutationMock: vi.fn(),
  draftGetForRecipeUseQueryMock: vi.fn(),
  draftGetNewDraftsUseQueryMock: vi.fn(),
  draftUpsertMutateMock: vi.fn(),
  draftDeleteMutateMock: vi.fn(),
  draftGetForRecipeInvalidateMock: vi.fn(),
  draftGetNewDraftsInvalidateMock: vi.fn(),
  useParamsMock: vi.fn(),
  navigateMock: vi.fn(),
  useLocationMock: vi.fn(),
}));

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    useUtils: () => ({
      recipes: {
        get: { invalidate: recipeGetInvalidateMock },
        list: { fetch: recipesListFetchMock },
        references: { invalidate: vi.fn().mockResolvedValue(undefined) },
      },
      ingredients: {
        list: { fetch: ingredientsListFetchMock, invalidate: vi.fn() },
      },
      recipeDrafts: {
        getForRecipe: { invalidate: draftGetForRecipeInvalidateMock },
        getNewDrafts: { invalidate: draftGetNewDraftsInvalidateMock },
      },
    }),
    recipes: {
      get: { useQuery: recipeGetUseQueryMock },
      references: { useQuery: referencesUseQueryMock },
      createSource: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      updateHeader: { useMutation: updateHeaderUseMutationMock },
      replaceIngredients: { useMutation: replaceIngredientsUseMutationMock },
      replaceMethod: { useMutation: replaceMethodUseMutationMock },
      setBatchFields: { useMutation: setBatchFieldsUseMutationMock },
    },
    ingredients: {
      references: { useQuery: () => ({ data: { categories: [], units: [] } }) },
      create: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    recipeDrafts: {
      getForRecipe: { useQuery: draftGetForRecipeUseQueryMock },
      getNewDrafts: { useQuery: draftGetNewDraftsUseQueryMock },
      upsert: { useMutation: () => ({ mutate: draftUpsertMutateMock }) },
      delete: { useMutation: () => ({ mutate: draftDeleteMutateMock }) },
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
    useNavigate: () => navigateMock,
    useLocation: useLocationMock,
  };
});

import { RecipeEditPage } from './recipe-edit-page.tsx';

function toHeaderShape(recipe: Recipe): Record<string, unknown> {
  return {
    name: recipe.name,
    description: recipe.description,
    imageUrl: recipe.imageUrl,
    baseServings: recipe.baseServings,
    activeTimeMins: recipe.activeTimeMins,
    totalTimeMins: recipe.totalTimeMins,
    estimatedCostPerServing: recipe.estimatedCostPerServing,
    sourceId: recipe.sourceId,
    sourceUrl: recipe.sourceUrl,
    caloriesPerServing: recipe.caloriesPerServing,
    proteinPerServing: recipe.proteinPerServing,
    carbsPerServing: recipe.carbsPerServing,
    fatPerServing: recipe.fatPerServing,
    saturatedFatPerServing: recipe.saturatedFatPerServing,
    fibrePerServing: recipe.fibrePerServing,
    sugarPerServing: recipe.sugarPerServing,
    saltPerServing: recipe.saltPerServing,
    isBase: recipe.isBase,
  };
}

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
  pairedRecipeId: null,
  baseRecipeName: null,
  baseRecipeIsDeleted: null,
  pairedRecipeName: null,
  pairedRecipeIsDeleted: null,
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
  useLocationMock.mockReturnValue({ hash: '' });
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
  setBatchFieldsUseMutationMock.mockReturnValue({
    mutateAsync: setBatchFieldsMutateAsyncMock,
  });
  recipesListFetchMock.mockResolvedValue({ items: [], nextCursor: null });
  recipeGetInvalidateMock.mockResolvedValue(undefined);
  draftGetForRecipeUseQueryMock.mockReturnValue({
    data: null,
    isSuccess: true,
    error: null,
  });
  draftGetNewDraftsUseQueryMock.mockReturnValue({
    data: [],
    isSuccess: true,
    error: null,
  });
  draftGetForRecipeInvalidateMock.mockResolvedValue(undefined);
  draftGetNewDraftsInvalidateMock.mockResolvedValue(undefined);
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

  it('scrolls the hash-targeted section into view once the recipe loads', async () => {
    useLocationMock.mockReturnValue({ hash: 'recipe-batch-heading' });
    const scrollIntoView = vi.fn();
    // jsdom does not implement scrollIntoView; stub it on the prototype. The
    // loose alias keeps the unbound-method rule off the captured reference.
    const proto = Element.prototype as unknown as Record<string, unknown>;
    const original = proto.scrollIntoView;
    proto.scrollIntoView = scrollIntoView;
    try {
      render(<RecipeEditPage />);
      await waitFor(() => {
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
      });
      const target = document.getElementById('recipe-batch-heading');
      expect(scrollIntoView.mock.instances[0]).toBe(target);
    } finally {
      proto.scrollIntoView = original;
    }
  });

  it('does not scroll when the location carries no hash', () => {
    useLocationMock.mockReturnValue({ hash: '' });
    const scrollIntoView = vi.fn();
    const proto = Element.prototype as unknown as Record<string, unknown>;
    const original = proto.scrollIntoView;
    proto.scrollIntoView = scrollIntoView;
    try {
      render(<RecipeEditPage />);
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      proto.scrollIntoView = original;
    }
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

  it('renders the unsaved-draft notice when a draft exists and seeds the form from it', () => {
    draftGetForRecipeUseQueryMock.mockReturnValue({
      data: {
        id: 99,
        draftData: {
          version: 1,
          fields: { header: { ...toHeaderShape(RECIPE), name: 'Draft name' } },
        },
        lastUpdatedAt: 1700000000000,
      },
      isSuccess: true,
      error: null,
    });

    render(<RecipeEditPage />);

    expect(screen.getByText('Unsaved draft restored.')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Draft name');
  });

  it('removes the unsaved-draft notice after the section is saved', async () => {
    updateHeaderMutateAsyncMock.mockResolvedValue({ id: 7 });
    draftDeleteMutateMock.mockImplementation(
      (_input: unknown, opts: { onSuccess?: () => void }) => {
        opts.onSuccess?.();
      },
    );
    draftGetForRecipeUseQueryMock.mockReturnValue({
      data: {
        id: 99,
        draftData: {
          version: 1,
          fields: { header: { ...toHeaderShape(RECIPE), name: 'Draft name' } },
        },
        lastUpdatedAt: 1700000000000,
      },
      isSuccess: true,
      error: null,
    });
    const user = userEvent.setup();
    render(<RecipeEditPage />);

    expect(screen.getByText('Unsaved draft restored.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save details' }));

    await waitFor(() => {
      expect(
        screen.queryByText('Unsaved draft restored.'),
      ).not.toBeInTheDocument();
    });
    expect(draftDeleteMutateMock).toHaveBeenCalledWith(
      { recipeId: 7 },
      expect.any(Object),
    );
  });

  it('discards the draft when the discard button is clicked', async () => {
    draftGetForRecipeUseQueryMock.mockReturnValue({
      data: {
        id: 99,
        draftData: { version: 1, fields: { header: { name: 'Draft' } } },
        lastUpdatedAt: 1700000000000,
      },
      isSuccess: true,
      error: null,
    });
    const user = userEvent.setup();
    render(<RecipeEditPage />);

    await user.click(screen.getByRole('button', { name: 'Discard draft' }));

    expect(draftDeleteMutateMock).toHaveBeenCalledWith(
      { recipeId: 7 },
      expect.any(Object),
    );
  });

  it('saves batch fields and invalidates the get query', async () => {
    setBatchFieldsMutateAsyncMock.mockResolvedValue({
      id: 7,
      isBase: true,
      baseRecipeId: null,
      pairedRecipeId: null,
    });
    const user = userEvent.setup();
    render(<RecipeEditPage />);

    await user.click(screen.getByLabelText(/this is a base recipe/i));
    await user.click(screen.getByRole('button', { name: 'Save batch fields' }));

    await waitFor(() => {
      expect(setBatchFieldsMutateAsyncMock).toHaveBeenCalledTimes(1);
    });
    expect(setBatchFieldsMutateAsyncMock.mock.calls[0]?.[0]).toEqual({
      id: 7,
      isBase: true,
    });
    expect(recipeGetInvalidateMock).toHaveBeenCalledWith({ id: 7 });
  });

  it('hides the base and pair pickers once the recipe is marked as a base', async () => {
    const user = userEvent.setup();
    render(<RecipeEditPage />);

    expect(screen.getByLabelText('Search base recipes')).toBeInTheDocument();
    expect(screen.getByLabelText('Search paired recipes')).toBeInTheDocument();
    await user.click(screen.getByLabelText(/this is a base recipe/i));
    expect(
      screen.queryByLabelText('Search base recipes'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText('Search paired recipes'),
    ).not.toBeInTheDocument();
  });

  it('flushes every section and returns to the recipe view on Save & Finish', async () => {
    updateHeaderMutateAsyncMock.mockResolvedValue({ id: 7 });
    replaceIngredientsMutateAsyncMock.mockResolvedValue(undefined);
    replaceMethodMutateAsyncMock.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<RecipeEditPage />);

    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Renamed soup');
    await user.click(screen.getByRole('button', { name: 'Save & Finish' }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith({
        to: '/recipes/$recipeId',
        params: { recipeId: '7' },
      });
    });
    expect(updateHeaderMutateAsyncMock.mock.calls[0]?.[0]).toEqual({
      id: 7,
      patch: { name: 'Renamed soup' },
    });
    expect(replaceIngredientsMutateAsyncMock).toHaveBeenCalledTimes(1);
    expect(replaceMethodMutateAsyncMock).toHaveBeenCalledTimes(1);
  });

  it('does not navigate on Save & Finish when a section save fails', async () => {
    updateHeaderMutateAsyncMock.mockRejectedValue(new Error('header boom'));
    const user = userEvent.setup();
    render(<RecipeEditPage />);

    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Renamed soup');
    await user.click(screen.getByRole('button', { name: 'Save & Finish' }));

    expect(await screen.findByText('header boom')).toBeVisible();
    expect(navigateMock).not.toHaveBeenCalled();
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
