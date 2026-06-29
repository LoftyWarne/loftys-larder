import type {
  ListRecipesResult,
  RelatedRecipeItem,
} from '@loftys-larder/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addMutateMock, removeMutateMock, invalidateListMock, fetchListMock } =
  vi.hoisted(() => ({
    addMutateMock: vi.fn(),
    removeMutateMock: vi.fn(),
    invalidateListMock: vi.fn().mockResolvedValue(undefined),
    fetchListMock: vi.fn(),
  }));

interface MutationState {
  isPending: boolean;
  error: unknown;
}

let listData: { items: RelatedRecipeItem[] } | undefined;
let listError: { message: string } | null = null;
let listLoading = false;
let addState: MutationState = { isPending: false, error: null };
let removeState: MutationState = { isPending: false, error: null };

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    useUtils: () => ({
      recipes: {
        listRelated: {
          invalidate: invalidateListMock,
        },
        list: {
          fetch: fetchListMock,
        },
      },
    }),
    recipes: {
      listRelated: {
        useQuery: () => ({
          data: listData,
          error: listError,
          isLoading: listLoading,
        }),
      },
      addRelated: {
        useMutation: (opts: { onSettled?: () => Promise<void> } = {}) => ({
          mutate: (
            input: { recipeId: number; otherRecipeId: number },
            handlers: { onSuccess?: () => void } = {},
          ) => {
            addMutateMock(input);
            handlers.onSuccess?.();
            void opts.onSettled?.();
          },
          isPending: addState.isPending,
          error: addState.error,
        }),
      },
      removeRelated: {
        useMutation: (opts: { onSettled?: () => Promise<void> } = {}) => ({
          mutate: (input: { recipeId: number; otherRecipeId: number }) => {
            removeMutateMock(input);
            void opts.onSettled?.();
          },
          isPending: removeState.isPending,
          error: removeState.error,
        }),
      },
    },
  },
}));

vi.mock('@tanstack/react-router', () => ({
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
    const href = params
      ? Object.entries(params).reduce(
          (acc, [key, value]) => acc.replace(`$${key}`, value),
          to,
        )
      : to;
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
}));

import { RelatedRecipes } from './related-recipes.tsx';

function makeItem(
  overrides: Partial<RelatedRecipeItem> = {},
): RelatedRecipeItem {
  return {
    id: 11,
    name: 'Aloo Gobi',
    imageUrl: null,
    ...overrides,
  };
}

function makeListResult(
  items: { id: number; name: string }[],
): ListRecipesResult {
  return {
    items: items.map((row) => ({
      id: row.id,
      name: row.name,
      imageUrl: null,
      baseServings: 2,
      activeTimeMins: null,
      totalTimeMins: null,
      isBase: false,
      baseRecipeId: null,
      isDeleted: false,
      plantPointsCount: 0,
      averageRating: null,
      ratingCount: 0,
    })),
    nextCursor: null,
  };
}

beforeEach(() => {
  addMutateMock.mockReset();
  removeMutateMock.mockReset();
  invalidateListMock.mockClear();
  fetchListMock.mockReset();
  listData = { items: [] };
  listError = null;
  listLoading = false;
  addState = { isPending: false, error: null };
  removeState = { isPending: false, error: null };
});

describe('RelatedRecipes', () => {
  it('renders the empty state when there are no links', () => {
    listData = { items: [] };
    render(<RelatedRecipes recipeId={7} />);
    expect(screen.getByText(/no related recipes yet/i)).toBeInTheDocument();
  });

  it('renders each related recipe as a chip linking to its detail page', () => {
    listData = {
      items: [makeItem({ id: 11, name: 'Aloo Gobi' })],
    };
    render(<RelatedRecipes recipeId={7} />);

    const link = screen.getByRole('link', { name: 'Aloo Gobi' });
    expect(link).toHaveAttribute('href', '/recipes/11');
  });

  it('excludes the current recipe and already-linked ids from suggestions', async () => {
    listData = {
      items: [makeItem({ id: 11, name: 'Aloo Gobi' })],
    };
    fetchListMock.mockResolvedValue(
      makeListResult([
        { id: 7, name: 'Self Recipe' },
        { id: 11, name: 'Aloo Gobi' },
        { id: 12, name: 'Biryani' },
      ]),
    );
    const user = userEvent.setup();
    render(<RelatedRecipes recipeId={7} />);

    await user.click(screen.getByRole('combobox'));

    expect(
      await screen.findByRole('option', { name: 'Biryani' }),
    ).toBeVisible();
    expect(screen.queryByRole('option', { name: 'Self Recipe' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Aloo Gobi' })).toBeNull();
  });

  it('calls addRelated with the picked id and clears the input on success', async () => {
    listData = { items: [] };
    fetchListMock.mockResolvedValue(
      makeListResult([{ id: 12, name: 'Biryani' }]),
    );
    const user = userEvent.setup();
    render(<RelatedRecipes recipeId={7} />);

    const input = screen.getByRole('combobox');
    await user.click(input);
    const option = await screen.findByRole('option', { name: 'Biryani' });
    await user.click(option);

    expect(addMutateMock).toHaveBeenCalledWith({
      recipeId: 7,
      otherRecipeId: 12,
    });
    await waitFor(() => {
      expect(invalidateListMock).toHaveBeenCalled();
    });
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('removes a chip via removeRelated when × is clicked', async () => {
    listData = {
      items: [makeItem({ id: 11, name: 'Aloo Gobi' })],
    };
    const user = userEvent.setup();
    render(<RelatedRecipes recipeId={7} />);

    await user.click(screen.getByRole('button', { name: 'Remove Aloo Gobi' }));

    expect(removeMutateMock).toHaveBeenCalledWith({
      recipeId: 7,
      otherRecipeId: 11,
    });
    await waitFor(() => {
      expect(invalidateListMock).toHaveBeenCalled();
    });
  });

  it('disables the combobox and chip remove buttons when isDisabled', () => {
    listData = {
      items: [makeItem({ id: 11, name: 'Aloo Gobi' })],
    };
    render(<RelatedRecipes recipeId={7} isDisabled />);

    expect(screen.getByRole('combobox')).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Remove Aloo Gobi' }),
    ).toBeDisabled();
  });

  it('surfaces RELATED_RECIPE_DUPLICATE as a friendly alert', () => {
    listData = { items: [] };
    addState = {
      isPending: false,
      error: {
        message: 'These recipes are already linked',
        data: { cause: { code: 'RELATED_RECIPE_DUPLICATE' } },
      },
    };
    render(<RelatedRecipes recipeId={7} />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/already linked/i);
  });
});
