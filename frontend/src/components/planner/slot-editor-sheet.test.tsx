import type {
  ListRecipesResult,
  PlanSlot,
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

import { SlotEditorSheet } from './slot-editor-sheet.tsx';

const MEAL_RECIPE: RecipeListItem = {
  id: 10,
  name: 'Tomato Pasta',
  imageUrl: null,
  baseServings: 4,
  activeTimeMins: null,
  totalTimeMins: null,
  isBase: false,
  baseRecipeId: 22,
  pairedRecipeId: null,
  isDeleted: false,
  plantPointsCount: 0,
  averageRating: null,
  ratingCount: 0,
};

const BASE_RECIPE: RecipeListItem = {
  ...MEAL_RECIPE,
  id: 22,
  name: 'Tomato Base',
  isBase: true,
  baseRecipeId: null,
};

const SUGGESTED_BASE = {
  id: 22,
  name: 'Tomato Base',
  baseServings: 8,
} as Recipe;

const BASE_SLOT: PlanSlot = {
  id: 5,
  planId: 1,
  date: '2026-06-15',
  occasionId: 2,
  occasionName: 'Dinner',
  slotType: 'recipe',
  recipeId: 10,
  numberOfServings: 4,
  chefUserId: null,
  cooksBaseRecipeId: null,
  cooksBaseServings: null,
  comment: null,
  recipe: {
    id: 10,
    name: 'Tomato Pasta',
    imageUrl: null,
    isBase: false,
    baseRecipeId: 22,
    isDeleted: false,
  },
  cooksBaseRecipe: null,
};

function setupListMock(items: RecipeListItem[] = []): void {
  const result: ListRecipesResult = { items, nextCursor: null };
  listFetchMock.mockResolvedValue(result);
}

beforeEach(() => {
  listFetchMock.mockReset();
  getQueryMock.mockReset();
  setupListMock([]);
  getQueryMock.mockReturnValue({ data: undefined });
});

describe('SlotEditorSheet — base cooking', () => {
  it('shows the suggested base hint when the meal is a batch-version with no base picked', () => {
    getQueryMock.mockReturnValue({ data: SUGGESTED_BASE });
    render(
      <SlotEditorSheet
        open
        slot={BASE_SLOT}
        members={[]}
        isSaving={false}
        hasBaseSupply={true}
        onClose={() => undefined}
        onSave={() => undefined}
      />,
    );
    expect(screen.getByTestId('base-suggestion-hint')).toHaveTextContent(
      /Suggested: Tomato Base/,
    );
  });

  it('does not auto-fill the base picker — the hint is opt-in', () => {
    getQueryMock.mockReturnValue({ data: SUGGESTED_BASE });
    render(
      <SlotEditorSheet
        open
        slot={BASE_SLOT}
        members={[]}
        isSaving={false}
        hasBaseSupply={true}
        onClose={() => undefined}
        onSave={() => undefined}
      />,
    );
    // The base picker exists; its input value should be empty until the hint
    // is clicked.
    expect(screen.queryByText('Base servings')).not.toBeInTheDocument();
  });

  it('applies the suggested base and exposes the servings input on click', async () => {
    const user = userEvent.setup();
    getQueryMock.mockReturnValue({ data: SUGGESTED_BASE });
    render(
      <SlotEditorSheet
        open
        slot={BASE_SLOT}
        members={[]}
        isSaving={false}
        hasBaseSupply={true}
        onClose={() => undefined}
        onSave={() => undefined}
      />,
    );
    await user.click(screen.getByTestId('base-suggestion-hint'));
    expect(screen.getByText('Base servings')).toBeInTheDocument();
  });

  it('shows the batch-supply warning when the meal is a batch-version with no supply', () => {
    getQueryMock.mockReturnValue({ data: SUGGESTED_BASE });
    render(
      <SlotEditorSheet
        open
        slot={BASE_SLOT}
        members={[]}
        isSaving={false}
        hasBaseSupply={false}
        onClose={() => undefined}
        onSave={() => undefined}
      />,
    );
    expect(screen.getByTestId('batch-supply-warning')).toBeInTheDocument();
  });

  it('hides the warning once a base is set, even with hasBaseSupply=false', async () => {
    const user = userEvent.setup();
    getQueryMock.mockReturnValue({ data: SUGGESTED_BASE });
    render(
      <SlotEditorSheet
        open
        slot={BASE_SLOT}
        members={[]}
        isSaving={false}
        hasBaseSupply={false}
        onClose={() => undefined}
        onSave={() => undefined}
      />,
    );
    await user.click(screen.getByTestId('base-suggestion-hint'));
    expect(
      screen.queryByTestId('batch-supply-warning'),
    ).not.toBeInTheDocument();
  });

  it('emits an UpdateSlotInput carrying both cook-base fields on save', async () => {
    const user = userEvent.setup();
    getQueryMock.mockReturnValue({ data: SUGGESTED_BASE });
    const onSave = vi.fn();
    render(
      <SlotEditorSheet
        open
        slot={BASE_SLOT}
        members={[]}
        isSaving={false}
        hasBaseSupply={true}
        onClose={() => undefined}
        onSave={onSave}
      />,
    );
    await user.click(screen.getByTestId('base-suggestion-hint'));
    await user.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalled();
    });
    const firstCall = onSave.mock.calls[0];
    if (!firstCall) throw new Error('expected onSave call');
    const input = firstCall[0] as UpdateSlotInput;
    expect(input.cooksBaseRecipeId).toBe(22);
    expect(input.cooksBaseServings).toBeGreaterThan(0);
  });

  it('does not show the suggestion hint when the meal is not a batch-version', () => {
    getQueryMock.mockReturnValue({ data: undefined });
    const flatSlot: PlanSlot = {
      ...BASE_SLOT,
      recipe: BASE_SLOT.recipe
        ? { ...BASE_SLOT.recipe, baseRecipeId: null }
        : null,
    };
    render(
      <SlotEditorSheet
        open
        slot={flatSlot}
        members={[]}
        isSaving={false}
        hasBaseSupply={true}
        onClose={() => undefined}
        onSave={() => undefined}
      />,
    );
    expect(
      screen.queryByTestId('base-suggestion-hint'),
    ).not.toBeInTheDocument();
  });
});

// Reference `BASE_RECIPE` so the assertions stay rooted to a stable mock row
// in case tests are added later that exercise the picker's search flow.
void BASE_RECIPE;
