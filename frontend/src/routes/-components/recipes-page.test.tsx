import type { ListRecipesResult, RecipeListItem } from '@loftys-larder/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listUseQueryMock } = vi.hoisted(() => ({
  listUseQueryMock: vi.fn(),
}));

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    recipes: {
      list: { useQuery: listUseQueryMock },
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
  pairedRecipeId: null,
  isDeleted: false,
  plantPointsCount: 3,
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
  pairedRecipeId: null,
  isDeleted: false,
  plantPointsCount: 2,
};

interface SetupOptions {
  items?: RecipeListItem[];
  isLoading?: boolean;
  error?: { message: string } | null;
}

function setup(options: SetupOptions = {}): void {
  const data: ListRecipesResult | undefined =
    options.isLoading || options.error
      ? undefined
      : { items: options.items ?? [TOMATO, ROAST], nextCursor: null };
  listUseQueryMock.mockReturnValue({
    data,
    isLoading: options.isLoading ?? false,
    error: options.error ?? null,
  });
}

beforeEach(() => {
  listUseQueryMock.mockReset();
});

describe('RecipesPage', () => {
  it('renders a card per recipe', () => {
    setup();
    render(<RecipesPage />);
    expect(screen.getByText('Tomato pasta')).toBeInTheDocument();
    expect(screen.getByText('Roast chicken')).toBeInTheDocument();
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
      expect(listUseQueryMock).toHaveBeenCalledWith({ search: 'pasta' });
    });
  });

  it('renders the plant-points chip on each card', () => {
    setup({ items: [TOMATO] });
    render(<RecipesPage />);
    expect(screen.getByLabelText(/plant points/i)).toHaveTextContent('3');
  });

  it('renders an error message when the list query fails', () => {
    setup({ error: { message: 'boom' } });
    render(<RecipesPage />);
    expect(screen.getByRole('alert')).toHaveTextContent(/boom/i);
  });
});
