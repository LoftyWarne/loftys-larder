import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  referencesUseQueryMock,
  createMutateAsyncMock,
  createUseMutationMock,
  navigateMock,
  draftGetNewDraftsUseQueryMock,
  draftGetForRecipeUseQueryMock,
  draftUpsertMutateMock,
  draftDeleteMutateMock,
  draftGetNewDraftsInvalidateMock,
  draftGetForRecipeInvalidateMock,
} = vi.hoisted(() => ({
  referencesUseQueryMock: vi.fn(),
  createMutateAsyncMock: vi.fn(),
  createUseMutationMock: vi.fn(),
  navigateMock: vi.fn(),
  draftGetNewDraftsUseQueryMock: vi.fn(),
  draftGetForRecipeUseQueryMock: vi.fn(),
  draftUpsertMutateMock: vi.fn(),
  draftDeleteMutateMock: vi.fn(),
  draftGetNewDraftsInvalidateMock: vi.fn(),
  draftGetForRecipeInvalidateMock: vi.fn(),
}));

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    useUtils: () => ({
      recipes: {
        references: { invalidate: vi.fn().mockResolvedValue(undefined) },
      },
      recipeDrafts: {
        getForRecipe: { invalidate: draftGetForRecipeInvalidateMock },
        getNewDrafts: { invalidate: draftGetNewDraftsInvalidateMock },
      },
    }),
    recipes: {
      references: { useQuery: referencesUseQueryMock },
      create: { useMutation: createUseMutationMock },
      createSource: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    recipeDrafts: {
      getForRecipe: { useQuery: draftGetForRecipeUseQueryMock },
      getNewDrafts: { useQuery: draftGetNewDraftsUseQueryMock },
      upsert: { useMutation: () => ({ mutate: draftUpsertMutateMock }) },
      delete: { useMutation: () => ({ mutate: draftDeleteMutateMock }) },
    },
  },
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>(
    '@tanstack/react-router',
  );
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

import { RecipeNewPage } from './recipe-new-page.tsx';

beforeEach(() => {
  vi.clearAllMocks();

  referencesUseQueryMock.mockReturnValue({
    data: { units: [], prepTypes: [], sources: [] },
    isLoading: false,
    error: null,
  });
  createUseMutationMock.mockReturnValue({
    mutateAsync: createMutateAsyncMock,
  });
  draftGetNewDraftsUseQueryMock.mockReturnValue({
    data: [],
    isSuccess: true,
    error: null,
  });
  draftGetForRecipeUseQueryMock.mockReturnValue({
    data: null,
    isSuccess: true,
    error: null,
  });
  draftGetNewDraftsInvalidateMock.mockResolvedValue(undefined);
  draftGetForRecipeInvalidateMock.mockResolvedValue(undefined);
});

describe('RecipeNewPage', () => {
  it('creates a recipe and navigates to the edit route on success', async () => {
    createMutateAsyncMock.mockResolvedValue({ id: 42 });
    navigateMock.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<RecipeNewPage />);

    await user.type(screen.getByLabelText('Name'), 'Borsch');
    await user.click(screen.getByRole('button', { name: 'Save & continue →' }));

    await waitFor(() => {
      expect(createMutateAsyncMock).toHaveBeenCalledTimes(1);
    });
    expect(createMutateAsyncMock.mock.calls[0]?.[0]).toMatchObject({
      name: 'Borsch',
      baseServings: 2,
    });
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/recipes/$recipeId/edit',
      params: { recipeId: '42' },
      hash: 'recipe-batch-heading',
    });
  });

  it('resumes the most recent new-recipe draft on mount', () => {
    draftGetNewDraftsUseQueryMock.mockReturnValue({
      data: [
        {
          id: 12,
          draftData: {
            version: 1,
            fields: { header: { name: 'Resumed draft', baseServings: 2 } },
          },
          lastUpdatedAt: 1700000000000,
        },
      ],
      isSuccess: true,
      error: null,
    });

    render(<RecipeNewPage />);
    expect(screen.getByText('Unsaved draft restored.')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Resumed draft');
  });

  it('deletes the new-recipe draft on successful create', async () => {
    createMutateAsyncMock.mockResolvedValue({ id: 99 });
    navigateMock.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<RecipeNewPage />);

    await user.type(screen.getByLabelText('Name'), 'New Soup');
    await user.click(screen.getByRole('button', { name: 'Save & continue →' }));

    await waitFor(() => {
      expect(draftDeleteMutateMock).toHaveBeenCalledWith(
        { recipeId: null },
        expect.any(Object),
      );
    });
  });

  it('surfaces a create error inline without navigating', async () => {
    createMutateAsyncMock.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    render(<RecipeNewPage />);

    await user.type(screen.getByLabelText('Name'), 'Borsch');
    await user.click(screen.getByRole('button', { name: 'Save & continue →' }));

    expect(await screen.findByText('boom')).toBeVisible();
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
