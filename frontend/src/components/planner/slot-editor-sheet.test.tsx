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

const { listFetchMock } = vi.hoisted(() => ({
  listFetchMock: vi.fn(),
}));

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    useUtils: () => ({
      recipes: {
        list: { fetch: listFetchMock },
      },
    }),
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

function setupListMock(items: RecipeListItem[] = []): void {
  const result: ListRecipesResult = { items, nextCursor: null };
  listFetchMock.mockResolvedValue(result);
}

beforeEach(() => {
  listFetchMock.mockReset();
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

  it('preserves the slot’s cook-ahead items when saving the meal', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <SlotEditorSheet
        open
        slot={SLOT_WITH_BASE}
        members={[]}
        isSaving={false}
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

  it('Clear empties the meal but preserves the cook-ahead items', () => {
    const onSave = vi.fn();
    render(
      <SlotEditorSheet
        open
        slot={SLOT_WITH_BASE}
        members={[]}
        isSaving={false}
        onClose={() => undefined}
        onSave={onSave}
      />,
    );
    screen.getByRole('button', { name: 'Clear' }).click();
    const input = onSave.mock.calls[0]?.[0] as UpdateSlotInput;
    expect(input.slotType).toBe('empty');
    expect(input.items).toEqual([
      expect.objectContaining({ recipeId: 22, kind: 'cook_ahead' }),
    ]);
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
});
