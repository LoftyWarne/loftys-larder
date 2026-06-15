import type { ListRecipesResult, RecipeListItem } from '@loftys-larder/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useInfiniteQueryMock } = vi.hoisted(() => ({
  useInfiniteQueryMock: vi.fn(),
}));

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    recipes: {
      list: { useInfiniteQuery: useInfiniteQueryMock },
    },
  },
}));

import { RecipeBank } from './recipe-bank.tsx';

const TOMATO: RecipeListItem = {
  id: 1,
  name: 'Tomato pasta',
  imageUrl: null,
  baseServings: 2,
  activeTimeMins: null,
  totalTimeMins: null,
  isBase: false,
  baseRecipeId: null,
  pairedRecipeId: null,
  isDeleted: false,
  plantPointsCount: 0,
  averageRating: null,
  ratingCount: 0,
};

const ROAST: RecipeListItem = { ...TOMATO, id: 2, name: 'Roast chicken' };

interface SetupOptions {
  items?: RecipeListItem[];
  hasNextPage?: boolean;
  isLoading?: boolean;
}

function setup(options: SetupOptions = {}): void {
  const pages: ListRecipesResult[] = [
    { items: options.items ?? [TOMATO, ROAST], nextCursor: null },
  ];
  useInfiniteQueryMock.mockReturnValue({
    data: options.isLoading ? undefined : { pages },
    isLoading: options.isLoading ?? false,
    error: null,
    hasNextPage: options.hasNextPage ?? false,
    fetchNextPage: vi.fn(),
    isFetchingNextPage: false,
  });
}

beforeEach(() => {
  useInfiniteQueryMock.mockReset();
});

describe('RecipeBank', () => {
  it('passes includePickerHidden: true to recipes.list', () => {
    setup();
    render(<RecipeBank selectedRecipeId={null} onSelect={() => undefined} />);
    expect(useInfiniteQueryMock).toHaveBeenCalled();
    const firstCall = useInfiniteQueryMock.mock.calls[0];
    if (!firstCall) throw new Error('expected list query call');
    const input = firstCall[0] as { includePickerHidden?: boolean };
    expect(input.includePickerHidden).toBe(true);
  });

  it('renders one option per recipe', () => {
    setup();
    render(<RecipeBank selectedRecipeId={null} onSelect={() => undefined} />);
    expect(
      screen.getByRole('option', { name: /tomato pasta/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: /roast chicken/i }),
    ).toBeInTheDocument();
  });

  it('marks the option matching selectedRecipeId as selected', () => {
    setup();
    render(<RecipeBank selectedRecipeId={1} onSelect={() => undefined} />);
    const selected = screen.getByRole('option', { name: /tomato pasta/i });
    expect(selected).toHaveAttribute('aria-selected', 'true');
    const unselected = screen.getByRole('option', { name: /roast chicken/i });
    expect(unselected).toHaveAttribute('aria-selected', 'false');
  });

  it('invokes onSelect with the recipe row when clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    setup();
    render(<RecipeBank selectedRecipeId={null} onSelect={onSelect} />);
    await user.click(screen.getByRole('option', { name: /tomato pasta/i }));
    expect(onSelect).toHaveBeenCalledWith(TOMATO);
  });

  it('toggles the selection off when the selected option is clicked again', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    setup();
    render(<RecipeBank selectedRecipeId={1} onSelect={onSelect} />);
    await user.click(screen.getByRole('option', { name: /tomato pasta/i }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('shows the empty state when no recipes are returned', () => {
    setup({ items: [] });
    render(<RecipeBank selectedRecipeId={null} onSelect={() => undefined} />);
    expect(screen.getByText(/no recipes yet/i)).toBeInTheDocument();
  });

  it('renders a Load more button when there is another page', () => {
    setup({ hasNextPage: true });
    render(<RecipeBank selectedRecipeId={null} onSelect={() => undefined} />);
    expect(
      screen.getByRole('button', { name: /load more/i }),
    ).toBeInTheDocument();
  });
});
