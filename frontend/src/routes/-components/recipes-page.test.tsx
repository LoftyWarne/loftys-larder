import type { ListRecipesResult, RecipeListItem } from '@loftys-larder/shared';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { listUseInfiniteQueryMock, listTagsUseQueryMock } = vi.hoisted(() => ({
  listUseInfiniteQueryMock: vi.fn(),
  listTagsUseQueryMock: vi.fn(),
}));

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    recipes: {
      list: { useInfiniteQuery: listUseInfiniteQueryMock },
      listTags: { useQuery: listTagsUseQueryMock },
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
  };
});

import { RecipesPage } from './recipes-page.tsx';

const TOMATO: RecipeListItem = {
  id: 1,
  name: 'Tomato pasta',
  imageUrl: 'https://example.test/tomato.jpg',
  baseServings: 2,
  activeTimeMins: 10,
  totalTimeMins: 25,
  isBase: false,
  baseRecipeId: null,
  isDeleted: false,
  plantPointsCount: 3,
  averageRating: 4.25,
  ratingCount: 4,
  tags: [],
};

const ROAST: RecipeListItem = {
  id: 2,
  name: 'Roast chicken',
  imageUrl: null,
  baseServings: 4,
  activeTimeMins: 15,
  totalTimeMins: 50,
  isBase: false,
  baseRecipeId: null,
  isDeleted: false,
  plantPointsCount: 2,
  averageRating: null,
  ratingCount: 0,
  tags: [],
};

interface SetupOptions {
  items?: RecipeListItem[];
  pages?: ListRecipesResult[];
  isLoading?: boolean;
  error?: { message: string } | null;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  isFetchNextPageError?: boolean;
}

function setup(options: SetupOptions = {}): { fetchNextPage: () => void } {
  const pages = options.pages ?? [
    { items: options.items ?? [TOMATO, ROAST], nextCursor: null },
  ];
  const fetchNextPage = vi.fn();
  listUseInfiniteQueryMock.mockReturnValue({
    data:
      options.isLoading || (options.error && !options.isFetchNextPageError)
        ? undefined
        : { pages },
    isLoading: options.isLoading ?? false,
    error: options.error ?? null,
    hasNextPage: options.hasNextPage ?? false,
    isFetchingNextPage: options.isFetchingNextPage ?? false,
    isFetchNextPageError: options.isFetchNextPageError ?? false,
    fetchNextPage,
  });
  return { fetchNextPage };
}

// jsdom has no IntersectionObserver. This fake records each live observer so
// a test can scroll the sentinel into view by hand.
const liveObservers = new Set<FakeIntersectionObserver>();

class FakeIntersectionObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {
    liveObservers.add(this);
  }
  observe(): void {
    return undefined;
  }
  disconnect(): void {
    liveObservers.delete(this);
  }
  trigger(isIntersecting: boolean): void {
    this.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

function scrollSentinelIntoView(): void {
  act(() => {
    for (const observer of liveObservers) observer.trigger(true);
  });
}

beforeEach(() => {
  listUseInfiniteQueryMock.mockReset();
  listTagsUseQueryMock.mockReset();
  listTagsUseQueryMock.mockReturnValue({ data: [] });
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
});

afterEach(() => {
  liveObservers.clear();
  vi.unstubAllGlobals();
});

describe('RecipesPage', () => {
  it('renders a card per recipe', () => {
    setup();
    render(<RecipesPage />);
    expect(screen.getByText('Tomato pasta')).toBeInTheDocument();
    expect(screen.getByText('Roast chicken')).toBeInTheDocument();
  });

  it('labels base recipes and leaves non-base recipes unlabelled', () => {
    setup({ items: [{ ...TOMATO, isBase: true }, ROAST] });
    render(<RecipesPage />);
    expect(screen.getByText('Base recipe')).toBeInTheDocument();
    expect(screen.getAllByText('Base recipe')).toHaveLength(1);
  });

  it('renders an image with the recipe name as alt text', () => {
    setup({ items: [TOMATO] });
    render(<RecipesPage />);
    const img = screen.getByAltText('Tomato pasta');
    expect(img).toHaveAttribute('src', TOMATO.imageUrl);
  });

  it('shows a fallback placeholder when the recipe has no image', () => {
    setup({ items: [ROAST] });
    render(<RecipesPage />);
    expect(screen.queryByAltText('Roast chicken')).not.toBeInTheDocument();
    expect(screen.getByText(/no image/i)).toBeInTheDocument();
  });

  it('shows the empty-state message when no recipes exist', () => {
    setup({ items: [] });
    render(<RecipesPage />);
    expect(screen.getByText(/no recipes yet/i)).toBeInTheDocument();
  });

  it('shows a distinct empty-state message when a search finds nothing', async () => {
    const user = userEvent.setup();
    setup({ items: [] });
    render(<RecipesPage />);

    await user.type(screen.getByLabelText(/search recipes/i), 'zzz');

    await waitFor(() => {
      expect(
        screen.getByText(/no recipes match your search/i),
      ).toBeInTheDocument();
    });
  });

  it('forwards the debounced search term to the list query', async () => {
    const user = userEvent.setup();
    setup();
    render(<RecipesPage />);

    await user.type(screen.getByLabelText(/search recipes/i), 'pasta');

    await waitFor(() => {
      expect(listUseInfiniteQueryMock).toHaveBeenLastCalledWith(
        { search: 'pasta', tagIds: undefined, limit: 30 },
        expect.anything(),
      );
    });
  });

  it('renders the plant-points chip on each card', () => {
    setup({ items: [TOMATO] });
    render(<RecipesPage />);
    expect(screen.getByLabelText(/plant points/i)).toHaveTextContent('3');
  });

  it('renders the average rating chip when the recipe has ratings', () => {
    setup({ items: [TOMATO] });
    render(<RecipesPage />);
    const chip = screen.getByLabelText(/average rating/i);
    expect(chip).toHaveTextContent('4.3');
    expect(chip).toHaveTextContent('(4)');
  });

  it('hides the rating chip when the recipe has no ratings', () => {
    setup({ items: [ROAST] });
    render(<RecipesPage />);
    expect(screen.queryByLabelText(/average rating/i)).not.toBeInTheDocument();
  });

  it('renders each recipe’s tags on its card', () => {
    setup({
      items: [
        {
          ...TOMATO,
          tags: [
            { id: 1, name: 'Quick' },
            { id: 2, name: 'weeknight' },
          ],
        },
      ],
    });
    render(<RecipesPage />);
    const tags = screen.getByRole('list', { name: 'Tags' });
    expect(tags).toHaveTextContent('Quick');
    expect(tags).toHaveTextContent('weeknight');
  });

  it('hides the tag filter when the household has no tags', () => {
    setup();
    render(<RecipesPage />);
    expect(
      screen.queryByRole('group', { name: /filter by tag/i }),
    ).not.toBeInTheDocument();
  });

  it('forwards every selected tag to the list query and clears on untoggle', async () => {
    const user = userEvent.setup();
    listTagsUseQueryMock.mockReturnValue({
      data: [
        { id: 1, name: 'Quick' },
        { id: 2, name: 'Vegetarian' },
      ],
    });
    setup();
    render(<RecipesPage />);

    const quick = screen.getByRole('button', { name: 'Quick' });
    await user.click(quick);
    await user.click(screen.getByRole('button', { name: 'Vegetarian' }));

    expect(quick).toHaveAttribute('aria-pressed', 'true');
    expect(listUseInfiniteQueryMock).toHaveBeenLastCalledWith(
      { search: undefined, tagIds: [1, 2], limit: 30 },
      expect.anything(),
    );

    await user.click(quick);
    await user.click(screen.getByRole('button', { name: 'Vegetarian' }));
    expect(listUseInfiniteQueryMock).toHaveBeenLastCalledWith(
      { search: undefined, tagIds: undefined, limit: 30 },
      expect.anything(),
    );
  });

  it('uses the no-match message when a tag filter finds nothing', async () => {
    const user = userEvent.setup();
    listTagsUseQueryMock.mockReturnValue({ data: [{ id: 1, name: 'Quick' }] });
    setup({ items: [] });
    render(<RecipesPage />);

    await user.click(screen.getByRole('button', { name: 'Quick' }));

    expect(
      screen.getByText(/no recipes match your search/i),
    ).toBeInTheDocument();
  });

  it('renders an error message when the list query fails', () => {
    setup({ error: { message: 'boom' } });
    render(<RecipesPage />);
    expect(screen.getByRole('alert')).toHaveTextContent(/boom/i);
  });

  it('renders the recipes from every loaded page in order', () => {
    setup({
      pages: [
        { items: [ROAST], nextCursor: { lowerName: 'roast chicken', id: 2 } },
        { items: [TOMATO], nextCursor: null },
      ],
    });
    render(<RecipesPage />);
    const names = screen
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(names[0]).toContain('Roast chicken');
    expect(names[1]).toContain('Tomato pasta');
  });

  it('reads the next cursor off the last page', () => {
    setup();
    render(<RecipesPage />);
    const options = listUseInfiniteQueryMock.mock.calls[0]?.[1] as {
      getNextPageParam: (page: ListRecipesResult) => unknown;
    };
    const cursor = { lowerName: 'tomato pasta', id: 1 };
    expect(
      options.getNextPageParam({ items: [TOMATO], nextCursor: cursor }),
    ).toEqual(cursor);
    expect(
      options.getNextPageParam({ items: [TOMATO], nextCursor: null }),
    ).toBeUndefined();
  });

  it('fetches the next page when the end of the list scrolls into view', () => {
    const { fetchNextPage } = setup({ hasNextPage: true });
    render(<RecipesPage />);

    scrollSentinelIntoView();

    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('does not fetch while the end of the list is out of view', () => {
    const { fetchNextPage } = setup({ hasNextPage: true });
    render(<RecipesPage />);

    act(() => {
      for (const observer of liveObservers) observer.trigger(false);
    });

    expect(fetchNextPage).not.toHaveBeenCalled();
  });

  it('stops watching for scroll once every page is loaded', () => {
    setup({ hasNextPage: false });
    render(<RecipesPage />);
    expect(liveObservers.size).toBe(0);
  });

  it('shows a loading line and does not double-fetch while the next page loads', () => {
    const { fetchNextPage } = setup({
      hasNextPage: true,
      isFetchingNextPage: true,
    });
    render(<RecipesPage />);

    expect(screen.getByRole('status')).toHaveTextContent(
      /loading more recipes/i,
    );
    expect(liveObservers.size).toBe(0);
    expect(fetchNextPage).not.toHaveBeenCalled();
  });

  it('offers a retry instead of auto-fetching when the next page fails', async () => {
    const user = userEvent.setup();
    const { fetchNextPage } = setup({
      hasNextPage: true,
      isFetchNextPageError: true,
      error: { message: 'boom' },
    });
    render(<RecipesPage />);

    expect(screen.getByText('Tomato pasta')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      /could not load more recipes: boom/i,
    );
    expect(liveObservers.size).toBe(0);

    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });
});
