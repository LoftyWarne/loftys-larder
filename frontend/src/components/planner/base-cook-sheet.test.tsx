import type {
  ListRecipesResult,
  PlanSlot,
  PlanSlotItem,
  Recipe,
  RecipeListItem,
  UpdateSlotInput,
} from '@loftys-larder/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listFetchMock, getQueryMock } = vi.hoisted(() => ({
  listFetchMock: vi.fn(),
  getQueryMock: vi.fn(),
}));

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    useUtils: () => ({
      recipes: {
        list: { fetch: listFetchMock },
      },
    }),
    recipes: {
      get: { useQuery: getQueryMock },
    },
  },
}));

import { BaseCookSheet } from './base-cook-sheet.tsx';

const BASE_RECIPE: RecipeListItem = {
  id: 22,
  name: 'Tomato Base',
  imageUrl: null,
  baseServings: 4,
  activeTimeMins: null,
  totalTimeMins: null,
  isBase: true,
  baseRecipeId: null,
  isDeleted: false,
  plantPointsCount: 0,
  averageRating: null,
  ratingCount: 0,
};

const SUGGESTED_BASE = {
  id: 22,
  name: 'Tomato Base',
  baseServings: 8,
} as Recipe;

function eatVariation(): PlanSlotItem {
  return {
    id: 1,
    recipeId: 10,
    recipeName: 'Tomato Pasta',
    recipeImageUrl: null,
    isBase: false,
    baseRecipeId: 22,
    isDeleted: false,
    servings: 4,
    kind: 'eat',
    sortOrder: 0,
  };
}

function cookBase(): PlanSlotItem {
  return {
    id: 2,
    recipeId: 22,
    recipeName: 'Tomato Base',
    recipeImageUrl: null,
    isBase: true,
    baseRecipeId: null,
    isDeleted: false,
    servings: 8,
    kind: 'cook_ahead',
    sortOrder: 1,
  };
}

const VARIATION_SLOT: PlanSlot = {
  id: 5,
  planId: 1,
  date: '2026-06-15',
  occasionId: 2,
  occasionName: 'Dinner',
  slotType: 'recipe',
  chefUserId: null,
  comment: null,
  items: [eatVariation()],
};

const EAT_OUT_SLOT: PlanSlot = {
  ...VARIATION_SLOT,
  slotType: 'eat_out',
  items: [],
};

const SLOT_WITH_BASE: PlanSlot = {
  ...VARIATION_SLOT,
  items: [eatVariation(), cookBase()],
};

function setupListMock(items: RecipeListItem[] = []): void {
  const result: ListRecipesResult = { items, nextCursor: null };
  listFetchMock.mockResolvedValue(result);
}

const noop = (): void => undefined;
const emptyRemaining = new Map<number, number>();

beforeEach(() => {
  listFetchMock.mockReset();
  getQueryMock.mockReset();
  setupListMock([]);
  getQueryMock.mockReturnValue({ data: undefined });
});

describe('BaseCookSheet', () => {
  it('auto-offers the meal’s base when eating a variation', () => {
    getQueryMock.mockReturnValue({ data: SUGGESTED_BASE });
    render(
      <BaseCookSheet
        open
        slot={VARIATION_SLOT}
        remainingByBase={emptyRemaining}
        isSaving={false}
        onClose={noop}
        onSave={noop}
      />,
    );
    expect(screen.getByTestId('base-suggestion-hint')).toHaveTextContent(
      /Tomato Base/,
    );
  });

  it('applies the suggested base and saves the full item list', async () => {
    const user = userEvent.setup();
    getQueryMock.mockReturnValue({ data: SUGGESTED_BASE });
    const onSave = vi.fn();
    render(
      <BaseCookSheet
        open
        slot={VARIATION_SLOT}
        remainingByBase={emptyRemaining}
        isSaving={false}
        onClose={noop}
        onSave={onSave}
      />,
    );
    await user.click(screen.getByTestId('base-suggestion-hint'));
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalled();
    });
    const input = onSave.mock.calls[0]?.[0] as UpdateSlotInput;
    // Preserves the eat dish and adds the cook-ahead base.
    expect(input.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recipeId: 10, kind: 'eat' }),
        expect.objectContaining({
          recipeId: 22,
          kind: 'cook_ahead',
          servings: 8,
        }),
      ]),
    );
  });

  it('is usable on a non-recipe (eat out) slot — base picker present, no auto-offer', () => {
    setupListMock([BASE_RECIPE]);
    render(
      <BaseCookSheet
        open
        slot={EAT_OUT_SLOT}
        remainingByBase={emptyRemaining}
        isSaving={false}
        onClose={noop}
        onSave={noop}
      />,
    );
    expect(screen.getByLabelText('Search base recipe')).toBeInTheDocument();
    expect(
      screen.queryByTestId('base-suggestion-hint'),
    ).not.toBeInTheDocument();
  });

  it('removes a cook-ahead item', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <BaseCookSheet
        open
        slot={SLOT_WITH_BASE}
        remainingByBase={emptyRemaining}
        isSaving={false}
        onClose={noop}
        onSave={onSave}
      />,
    );
    await user.click(
      screen.getByRole('button', { name: /Remove Tomato Base/i }),
    );
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalled();
    });
    const input = onSave.mock.calls[0]?.[0] as UpdateSlotInput;
    expect(input.items.filter((i) => i.kind === 'cook_ahead')).toHaveLength(0);
  });

  it('shows the remaining base for a cooked base', () => {
    render(
      <BaseCookSheet
        open
        slot={SLOT_WITH_BASE}
        remainingByBase={new Map([[22, 3]])}
        isSaving={false}
        onClose={noop}
        onSave={noop}
      />,
    );
    expect(screen.getByTestId('base-remaining')).toHaveTextContent(
      /3 left in plan/,
    );
  });

  it('shows a shortfall warning when the slot is short', () => {
    render(
      <BaseCookSheet
        open
        slot={VARIATION_SLOT}
        remainingByBase={emptyRemaining}
        shortBy={2}
        isSaving={false}
        onClose={noop}
        onSave={noop}
      />,
    );
    expect(screen.getByTestId('serving-variation-warning')).toHaveTextContent(
      /short by 2/,
    );
  });
});
