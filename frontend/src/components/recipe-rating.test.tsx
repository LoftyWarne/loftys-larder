import type { Recipe } from '@loftys-larder/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  rateMutateMock,
  unrateMutateMock,
  getDataMock,
  setDataMock,
  cancelMock,
  invalidateGetMock,
  invalidateListMock,
} = vi.hoisted(() => ({
  rateMutateMock: vi.fn(),
  unrateMutateMock: vi.fn(),
  getDataMock: vi.fn(),
  setDataMock: vi.fn(),
  cancelMock: vi.fn().mockResolvedValue(undefined),
  invalidateGetMock: vi.fn().mockResolvedValue(undefined),
  invalidateListMock: vi.fn().mockResolvedValue(undefined),
}));

let rateOptions: Record<string, unknown> = {};
let unrateOptions: Record<string, unknown> = {};
let ratePending = false;
let unratePending = false;

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    useUtils: () => ({
      recipes: {
        get: {
          cancel: cancelMock,
          getData: getDataMock,
          setData: setDataMock,
          invalidate: invalidateGetMock,
        },
        list: {
          invalidate: invalidateListMock,
        },
      },
    }),
    recipes: {
      rate: {
        useMutation: (opts: Record<string, unknown>) => {
          rateOptions = opts;
          return { mutate: rateMutateMock, isPending: ratePending };
        },
      },
      unrate: {
        useMutation: (opts: Record<string, unknown>) => {
          unrateOptions = opts;
          return { mutate: unrateMutateMock, isPending: unratePending };
        },
      },
    },
  },
}));

import { RecipeRating } from './recipe-rating.tsx';

const BASE_RECIPE: Recipe = {
  id: 7,
  name: 'Onion Soup',
  description: null,
  imageUrl: null,
  baseServings: 2,
  activeTimeMins: null,
  totalTimeMins: null,
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
  baseRecipeName: null,
  baseRecipeIsDeleted: null,
  pairedRecipeName: null,
  pairedRecipeIsDeleted: null,
  isDeleted: false,
  plantPointsCount: 0,
  averageRating: 3,
  ratingCount: 2,
  yourRating: 3,
  ingredients: [],
  method: [],
};

beforeEach(() => {
  rateMutateMock.mockReset();
  unrateMutateMock.mockReset();
  getDataMock.mockReset();
  setDataMock.mockReset();
  cancelMock.mockClear();
  invalidateGetMock.mockClear();
  invalidateListMock.mockClear();
  rateOptions = {};
  unrateOptions = {};
  ratePending = false;
  unratePending = false;
});

describe('RecipeRating', () => {
  it('renders five star buttons with fills reflecting yourRating', () => {
    render(<RecipeRating recipeId={7} yourRating={3} />);
    const stars = screen.getAllByRole('button');
    expect(stars).toHaveLength(5);
    expect(stars[0]).toHaveTextContent('★');
    expect(stars[2]).toHaveTextContent('★');
    expect(stars[3]).toHaveTextContent('☆');
    expect(stars[4]).toHaveTextContent('☆');
  });

  it('renders all hollow stars when yourRating is null', () => {
    render(<RecipeRating recipeId={7} yourRating={null} />);
    for (const star of screen.getAllByRole('button')) {
      expect(star).toHaveTextContent('☆');
    }
  });

  it('calls rate when clicking an unselected star', async () => {
    const user = userEvent.setup();
    render(<RecipeRating recipeId={7} yourRating={null} />);
    await user.click(screen.getByRole('button', { name: /rate 4 stars/i }));
    expect(rateMutateMock).toHaveBeenCalledWith({ recipeId: 7, rating: 4 });
    expect(unrateMutateMock).not.toHaveBeenCalled();
  });

  it('calls unrate when clicking the currently-selected star', async () => {
    const user = userEvent.setup();
    render(<RecipeRating recipeId={7} yourRating={3} />);
    await user.click(
      screen.getByRole('button', { name: /clear your rating/i }),
    );
    expect(unrateMutateMock).toHaveBeenCalledWith({ recipeId: 7 });
    expect(rateMutateMock).not.toHaveBeenCalled();
  });

  it('optimistically updates cached recipe on rate; rolls back on error', async () => {
    getDataMock.mockReturnValue(BASE_RECIPE);
    render(<RecipeRating recipeId={7} yourRating={3} />);

    const onMutate = rateOptions.onMutate as (vars: {
      recipeId: number;
      rating: number;
    }) => Promise<{ previous: Recipe | undefined }>;
    const onError = rateOptions.onError as (
      err: unknown,
      vars: unknown,
      ctx: { previous: Recipe | undefined } | undefined,
    ) => void;

    const ctx = await onMutate({ recipeId: 7, rating: 5 });
    expect(setDataMock).toHaveBeenCalledTimes(1);
    const firstCall = setDataMock.mock.calls[0];
    if (!firstCall) throw new Error('expected setData call');
    expect(firstCall[1]).toMatchObject({
      yourRating: 5,
      ratingCount: 2,
      averageRating: 4,
    });

    setDataMock.mockClear();
    onError(new Error('boom'), { recipeId: 7, rating: 5 }, ctx);
    expect(setDataMock).toHaveBeenCalledWith({ id: 7 }, BASE_RECIPE);
  });

  it('optimistically clears the rating on unrate', async () => {
    getDataMock.mockReturnValue(BASE_RECIPE);
    render(<RecipeRating recipeId={7} yourRating={3} />);

    const onMutate = unrateOptions.onMutate as (vars: {
      recipeId: number;
    }) => Promise<{ previous: Recipe | undefined }>;
    await onMutate({ recipeId: 7 });
    expect(setDataMock).toHaveBeenCalledTimes(1);
    const firstCall = setDataMock.mock.calls[0];
    if (!firstCall) throw new Error('expected setData call');
    expect(firstCall[1]).toMatchObject({
      yourRating: null,
      ratingCount: 1,
      averageRating: 3,
    });
  });

  it('disables all buttons when isDisabled is true', () => {
    render(<RecipeRating recipeId={7} yourRating={2} isDisabled />);
    for (const star of screen.getAllByRole('button')) {
      expect(star).toBeDisabled();
    }
  });

  it('does not fire mutations when disabled', async () => {
    const user = userEvent.setup();
    render(<RecipeRating recipeId={7} yourRating={null} isDisabled />);
    await user.click(screen.getByRole('button', { name: /rate 1 stars/i }));
    expect(rateMutateMock).not.toHaveBeenCalled();
  });
});
