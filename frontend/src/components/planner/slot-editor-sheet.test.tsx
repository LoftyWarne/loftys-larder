import type {
  ListRecipesResult,
  PlanSlot,
  PlanSlotItem,
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

function eat(overrides: Partial<PlanSlotItem> = {}): PlanSlotItem {
  return {
    id: 1,
    recipeId: 10,
    recipeName: 'Tomato Pasta',
    recipeImageUrl: null,
    isBase: false,
    baseRecipeId: null,
    isDeleted: false,
    servings: 4,
    kind: 'eat',
    sortOrder: 0,
    ...overrides,
  };
}

function cook(overrides: Partial<PlanSlotItem> = {}): PlanSlotItem {
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
    ...overrides,
  };
}

const RECIPE_SLOT: PlanSlot = {
  id: 5,
  planId: 1,
  date: '2026-06-15',
  occasionId: 2,
  occasionName: 'Dinner',
  slotType: 'recipe',
  chefUserId: null,
  comment: null,
  items: [eat()],
};

const SLOT_WITH_BASE: PlanSlot = {
  ...RECIPE_SLOT,
  items: [eat(), cook()],
};

function listItem(overrides: Partial<RecipeListItem> = {}): RecipeListItem {
  return {
    id: 30,
    name: 'Salad',
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
    ...overrides,
  };
}

function setupListMock(items: RecipeListItem[] = []): void {
  const result: ListRecipesResult = { items, nextCursor: null };
  listFetchMock.mockResolvedValue(result);
}

beforeEach(() => {
  listFetchMock.mockReset();
  getQueryMock.mockReset();
  getQueryMock.mockReturnValue({ data: undefined });
  setupListMock([]);
});

describe('SlotEditorSheet — meal items', () => {
  it('renders the dishes and no base-cook section', () => {
    render(
      <SlotEditorSheet
        open
        slot={RECIPE_SLOT}
        members={[]}
        isSaving={false}
        slots={[]}
        onClose={() => undefined}
        onSave={() => undefined}
      />,
    );
    expect(screen.getByText('Dishes')).toBeInTheDocument();
    expect(screen.getByText('Tomato Pasta')).toBeInTheDocument();
    expect(
      screen.queryByText('Cooking a base for batch use?'),
    ).not.toBeInTheDocument();
  });

  it('saves eaten dishes and cooked-ahead bases as one items list', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <SlotEditorSheet
        open
        slot={SLOT_WITH_BASE}
        members={[]}
        isSaving={false}
        slots={[]}
        onClose={() => undefined}
        onSave={onSave}
      />,
    );
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalled();
    });
    const input = onSave.mock.calls[0]?.[0] as UpdateSlotInput;
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

  it('renders each dish with a type badge (cooked base included)', () => {
    render(
      <SlotEditorSheet
        open
        slot={SLOT_WITH_BASE}
        members={[]}
        isSaving={false}
        slots={[]}
        onClose={() => undefined}
        onSave={() => undefined}
      />,
    );
    expect(screen.getByText('Tomato Pasta')).toBeInTheDocument();
    expect(screen.getByText(/Tomato Base/)).toBeInTheDocument();
    const badges = screen.getAllByTestId('recipe-type-badge');
    expect(badges.map((b) => b.textContent)).toEqual(['Standalone', 'Base']);
  });

  it('Clear empties the slot entirely', () => {
    const onSave = vi.fn();
    render(
      <SlotEditorSheet
        open
        slot={SLOT_WITH_BASE}
        members={[]}
        isSaving={false}
        slots={[]}
        onClose={() => undefined}
        onSave={onSave}
      />,
    );
    screen.getByRole('button', { name: 'Clear' }).click();
    const input = onSave.mock.calls[0]?.[0] as UpdateSlotInput;
    expect(input.slotType).toBe('empty');
    expect(input.items).toEqual([]);
  });

  it('removes a dish from the list', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <SlotEditorSheet
        open
        slot={RECIPE_SLOT}
        members={[]}
        isSaving={false}
        slots={[]}
        onClose={() => undefined}
        onSave={onSave}
      />,
    );
    await user.click(
      screen.getByRole('button', { name: /Remove Tomato Pasta/i }),
    );
    // With no eat dishes left, a 'recipe' slot can't save — switch to eat out.
    await user.click(screen.getByText('Eat out'));
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalled();
    });
    const input = onSave.mock.calls[0]?.[0] as UpdateSlotInput;
    expect(input.items.filter((i) => i.kind === 'eat')).toHaveLength(0);
  });

  it('adds a picked base recipe as a cooked-ahead item', async () => {
    const user = userEvent.setup();
    setupListMock([
      listItem({ id: 40, name: 'Ragu Base', isBase: true, baseServings: 6 }),
    ]);
    const onSave = vi.fn();
    render(
      <SlotEditorSheet
        open
        slot={{ ...RECIPE_SLOT, items: [] }}
        members={[]}
        isSaving={false}
        slots={[]}
        onClose={() => undefined}
        onSave={onSave}
      />,
    );
    await user.click(screen.getByRole('combobox', { name: 'Add a dish' }));
    await user.click(await screen.findByText('Ragu Base'));
    expect(screen.getByTestId('recipe-type-badge')).toHaveTextContent('Base');
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalled();
    });
    const input = onSave.mock.calls[0]?.[0] as UpdateSlotInput;
    expect(input.items).toEqual([
      expect.objectContaining({
        recipeId: 40,
        kind: 'cook_ahead',
        servings: 6,
      }),
    ]);
  });

  it('offers to cook the base behind an eaten variation', async () => {
    const user = userEvent.setup();
    getQueryMock.mockReturnValue({
      data: {
        id: 22,
        name: 'Tomato Base',
        imageUrl: null,
        isBase: true,
        baseRecipeId: null,
        isDeleted: false,
        baseServings: 8,
      },
    });
    const onSave = vi.fn();
    render(
      <SlotEditorSheet
        open
        slot={{ ...RECIPE_SLOT, items: [eat({ baseRecipeId: 22 })] }}
        members={[]}
        isSaving={false}
        slots={[]}
        onClose={() => undefined}
        onSave={onSave}
      />,
    );
    const hint = await screen.findByTestId('base-suggestion-hint');
    expect(hint).toHaveTextContent('Tomato Base');
    await user.click(hint);
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalled();
    });
    const input = onSave.mock.calls[0]?.[0] as UpdateSlotInput;
    expect(input.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipeId: 22,
          kind: 'cook_ahead',
          servings: 8,
        }),
      ]),
    );
  });

  it('shows a shortfall warning computed from the live items', () => {
    // Eats 5 servings of a variation of base 22, but only 3 are cooked here.
    render(
      <SlotEditorSheet
        open
        slot={{
          ...RECIPE_SLOT,
          items: [
            cook({ recipeId: 22, servings: 3 }),
            eat({ recipeId: 10, baseRecipeId: 22, servings: 5 }),
          ],
        }}
        members={[]}
        isSaving={false}
        slots={[]}
        onClose={() => undefined}
        onSave={() => undefined}
      />,
    );
    expect(screen.getByTestId('serving-variation-warning')).toHaveTextContent(
      'short by 2',
    );
  });

  it('recomputes "left in plan" against the live items', () => {
    // 8 base servings cooked, a variation eats 3 → 5 left.
    render(
      <SlotEditorSheet
        open
        slot={{
          ...RECIPE_SLOT,
          items: [cook(), eat({ recipeId: 10, baseRecipeId: 22, servings: 3 })],
        }}
        members={[]}
        isSaving={false}
        slots={[]}
        onClose={() => undefined}
        onSave={() => undefined}
      />,
    );
    expect(screen.getByTestId('base-remaining')).toHaveTextContent(
      '5 left in plan',
    );
  });
});
