import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  referencesUseQueryMock,
  createMutateAsyncMock,
  createUseMutationMock,
  navigateMock,
} = vi.hoisted(() => ({
  referencesUseQueryMock: vi.fn(),
  createMutateAsyncMock: vi.fn(),
  createUseMutationMock: vi.fn(),
  navigateMock: vi.fn(),
}));

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    recipes: {
      references: { useQuery: referencesUseQueryMock },
      create: { useMutation: createUseMutationMock },
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
  referencesUseQueryMock.mockReset();
  createMutateAsyncMock.mockReset();
  createUseMutationMock.mockReset();
  navigateMock.mockReset();

  referencesUseQueryMock.mockReturnValue({
    data: { units: [], prepTypes: [], sources: [] },
    isLoading: false,
    error: null,
  });
  createUseMutationMock.mockReturnValue({
    mutateAsync: createMutateAsyncMock,
  });
});

describe('RecipeNewPage', () => {
  it('creates a recipe and navigates to the edit route on success', async () => {
    createMutateAsyncMock.mockResolvedValue({ id: 42 });
    navigateMock.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<RecipeNewPage />);

    await user.type(screen.getByLabelText('Name'), 'Borsch');
    await user.click(screen.getByRole('button', { name: 'Create recipe' }));

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
    });
  });

  it('surfaces a create error inline without navigating', async () => {
    createMutateAsyncMock.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    render(<RecipeNewPage />);

    await user.type(screen.getByLabelText('Name'), 'Borsch');
    await user.click(screen.getByRole('button', { name: 'Create recipe' }));

    expect(await screen.findByText('boom')).toBeVisible();
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
