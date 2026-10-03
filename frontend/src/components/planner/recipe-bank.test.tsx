import type { ListRecipesResult, RecipeListItem } from '@loftys-larder/shared';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useInfiniteQueryMock } = vi.hoisted(() => ({
  useInfiniteQueryMock: vi.fn(),
}));

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    recipes: {
      list: { useInfiniteQuery: useInfiniteQueryMock },
      listTags: { useQuery: () => ({ data: [] }) },
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
  isDeleted: false,
  plantPointsCount: 0,
  healthScore: null,
  averageRating: null,
  ratingCount: 0,
  tags: [],
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
    render(<RecipeBank />);
    expect(useInfiniteQueryMock).toHaveBeenCalled();
    const firstCall = useInfiniteQueryMock.mock.calls[0];
    if (!firstCall) throw new Error('expected list query call');
    const input = firstCall[0] as { includePickerHidden?: boolean };
    expect(input.includePickerHidden).toBe(true);
  });

  it('renders one row per recipe', () => {
    setup();
    render(<RecipeBank />);
    expect(
      screen.getByRole('button', { name: /tomato pasta/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /roast chicken/i }),
    ).toBeInTheDocument();
  });

  it('has no selection state — rows are drag sources only', () => {
    setup();
    render(<RecipeBank dndEnabled />);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    const row = screen.getByRole('button', { name: /tomato pasta/i });
    expect(row).not.toHaveAttribute('aria-selected');
    expect(row.className).toContain('cursor-grab');
  });

  it('shows the empty state when no recipes are returned', () => {
    setup({ items: [] });
    render(<RecipeBank />);
    expect(screen.getByText(/no recipes yet/i)).toBeInTheDocument();
  });

  it('renders a Load more button when there is another page', () => {
    setup({ hasNextPage: true });
    render(<RecipeBank />);
    expect(
      screen.getByRole('button', { name: /load more/i }),
    ).toBeInTheDocument();
  });
});
