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
    prepared: 4,
    eaten: 4,
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
    prepared: 8,
    eaten: 0,
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
  leftoversSource: null,
  chefUserId: null,
  comment: null,
  items: [eat()],
  dinerUserIds: [],
  guestCount: 0,
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

describe('SlotEditorSheet — chef field', () => {
  const MEMBERS = [{ id: 'u1', name: 'Conor', email: 'conor@example.com' }];

  it('shows the Chef field on a Cooking slot', () => {
    render(
      <SlotEditorSheet
        open
        slot={RECIPE_SLOT}
        members={MEMBERS}
        isSaving={false}
        slots={[]}
        onClose={() => undefined}
        onSave={() => undefined}
      />,
    );
    expect(screen.getByText('Chef')).toBeInTheDocument();
  });

  it('hides the Chef field on a non-Cooking slot', () => {
    render(
      <SlotEditorSheet
        open
        slot={{ ...RECIPE_SLOT, slotType: 'eat_out', items: [] }}
        members={MEMBERS}
        isSaving={false}
        slots={[]}
        onClose={() => undefined}
        onSave={() => undefined}
      />,
    );
    expect(screen.queryByText('Chef')).not.toBeInTheDocument();
  });

  it('clears a previously set chef when switching off the Cooking type', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <SlotEditorSheet
        open
        slot={{ ...RECIPE_SLOT, chefUserId: 'u1' }}
        members={MEMBERS}
        isSaving={false}
        slots={[]}
        onClose={() => undefined}
        onSave={onSave}
      />,
    );
    await user.click(screen.getByText('Eat out'));
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalled();
    });
    const input = onSave.mock.calls[0]?.[0] as UpdateSlotInput;
    expect(input.slotType).toBe('eat_out');
    expect(input.chefUserId).toBeNull();
  });
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

  it('opens a base-only empty slot in the Cooking tab with the base shown', () => {
    render(
      <SlotEditorSheet
        open
        slot={{ ...RECIPE_SLOT, slotType: 'empty', items: [cook()] }}
        members={[]}
        isSaving={false}
        slots={[]}
        onClose={() => undefined}
        onSave={() => undefined}
      />,
    );
    expect(screen.getByRole('radio', { name: 'Cooking' })).toBeChecked();
    expect(screen.getByText('Dishes')).toBeInTheDocument();
    expect(screen.getByText('Tomato Base')).toBeInTheDocument();
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
        expect.objectContaining({ recipeId: 10, prepared: 4, eaten: 4 }),
        expect.objectContaining({
          recipeId: 22,
          prepared: 8,
          eaten: 0,
        }),
      ]),
    );
  });

  it('exposes the full dish name as a title tooltip (names can truncate)', () => {
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
    expect(screen.getByText('Tomato Pasta')).toHaveAttribute(
      'title',
      'Tomato Pasta',
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
    expect(input.items.filter((i) => i.eaten > 0)).toHaveLength(0);
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
        prepared: 6,
        eaten: 0,
      }),
    ]);
    // DEC-91: nothing eaten means this isn't a `recipe` occasion. A batch-only
    // slot saves as `empty` while keeping its prepared item (the schema refine
    // forbids `recipe` with zero eaten items).
    expect(input.slotType).toBe('empty');
  });

  it('keeps a base alongside an eaten dish as a recipe slot', async () => {
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
    // An eaten dish is present, so the occasion stays `recipe` and the base
    // rides along as a prepared-only cook-ahead item.
    expect(input.slotType).toBe('recipe');
    expect(input.items.filter((i) => i.eaten > 0)).toHaveLength(1);
    expect(
      input.items.filter((i) => i.eaten === 0 && i.prepared > 0),
    ).toHaveLength(1);
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
          prepared: 8,
          eaten: 0,
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
            cook({ recipeId: 22, prepared: 3 }),
            eat({ recipeId: 10, baseRecipeId: 22, prepared: 5, eaten: 5 }),
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

  it('shows the shortfall under each short dish, not once per slot', () => {
    render(
      <SlotEditorSheet
        open
        // Two variations of different uncooked bases — each runs its base short.
        slot={{
          ...RECIPE_SLOT,
          items: [
            eat({ recipeId: 10, baseRecipeId: 22, prepared: 3, eaten: 3 }),
            eat({ recipeId: 11, baseRecipeId: 33, prepared: 2, eaten: 2 }),
          ],
        }}
        members={[]}
        isSaving={false}
        slots={[]}
        onClose={() => undefined}
        onSave={() => undefined}
      />,
    );
    const warnings = screen.getAllByTestId('serving-variation-warning');
    expect(warnings).toHaveLength(2);
    expect(warnings.map((w) => w.textContent).join(' ')).toMatch(/short by 3/);
    expect(warnings.map((w) => w.textContent).join(' ')).toMatch(/short by 2/);
  });

  it('recomputes "left in plan" against the live items', () => {
    // 8 base servings cooked, a variation eats 3 → 5 left.
    render(
      <SlotEditorSheet
        open
        slot={{
          ...RECIPE_SLOT,
          items: [
            cook(),
            eat({ recipeId: 10, baseRecipeId: 22, prepared: 3, eaten: 3 }),
          ],
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

  it('clears the shortfall warning when the base is added to the dishes', async () => {
    const user = userEvent.setup();
    // The base that supplies the eaten variation is offered by the picker.
    setupListMock([
      listItem({ id: 22, name: 'Tomato Base', isBase: true, baseServings: 8 }),
    ]);
    render(
      <SlotEditorSheet
        open
        // Eating 5 of a variation of base 22, nothing cooking it yet.
        slot={{
          ...RECIPE_SLOT,
          items: [
            eat({ recipeId: 10, baseRecipeId: 22, prepared: 5, eaten: 5 }),
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
      'short by 5',
    );

    // Listing the base in the day's dishes cooks 8 servings, covering the 5.
    await user.click(screen.getByRole('button', { name: 'Add another dish' }));
    await user.type(
      screen.getByRole('combobox', { name: 'Add a dish' }),
      'Tomato',
    );
    await user.click(await screen.findByText('Tomato Base'));

    expect(
      screen.queryByTestId('serving-variation-warning'),
    ).not.toBeInTheDocument();
  });

  it('caps the eaten quantity at the prepared quantity', async () => {
    const user = userEvent.setup();
    render(
      <SlotEditorSheet
        open
        // eat() defaults to prepared 4, eaten 4.
        slot={RECIPE_SLOT}
        members={[]}
        isSaving={false}
        slots={[]}
        onClose={() => undefined}
        onSave={() => undefined}
      />,
    );
    const eatenInput = screen.getByLabelText('Eaten for Tomato Pasta');
    await user.clear(eatenInput);
    await user.type(eatenInput, '9');
    // Can't eat more than the 4 prepared.
    expect(eatenInput).toHaveValue(4);
  });

  it('pulls eaten down when prepared is lowered below it', async () => {
    const user = userEvent.setup();
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
    const preparedInput = screen.getByLabelText('Prepared for Tomato Pasta');
    await user.clear(preparedInput);
    await user.type(preparedInput, '2');
    expect(screen.getByLabelText('Eaten for Tomato Pasta')).toHaveValue(2);
  });
});

describe("SlotEditorSheet — who's eating", () => {
  const MEMBERS = [
    { id: 'u1', name: 'Conor', email: 'conor@example.com' },
    { id: 'u2', name: 'Sam', email: 'sam@example.com' },
  ];

  it('saves the selected members and guest count', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <SlotEditorSheet
        open
        slot={RECIPE_SLOT}
        members={MEMBERS}
        isSaving={false}
        slots={[]}
        onClose={() => undefined}
        onSave={onSave}
      />,
    );
    await user.click(screen.getByRole('checkbox', { name: 'Conor' }));
    await user.clear(screen.getByLabelText('Number of guests'));
    await user.type(screen.getByLabelText('Number of guests'), '2');
    expect(screen.getByText('(3 eating)')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalled();
    });
    const input = onSave.mock.calls[0]?.[0] as UpdateSlotInput;
    expect(input.dinerUserIds).toEqual(['u1']);
    expect(input.guestCount).toBe(2);
  });

  it('keeps who is eating when the slot type changes to empty', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <SlotEditorSheet
        open
        slot={RECIPE_SLOT}
        members={MEMBERS}
        isSaving={false}
        slots={[]}
        onClose={() => undefined}
        onSave={onSave}
      />,
    );
    await user.click(screen.getByRole('checkbox', { name: 'Conor' }));
    await user.clear(screen.getByLabelText('Number of guests'));
    await user.type(screen.getByLabelText('Number of guests'), '2');

    await user.click(screen.getByRole('radio', { name: 'Empty' }));
    // Attendance stays on screen through the type change.
    expect(screen.getByText('(3 eating)')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalled();
    });
    const input = onSave.mock.calls[0]?.[0] as UpdateSlotInput;
    expect(input.slotType).toBe('empty');
    expect(input.dinerUserIds).toEqual(['u1']);
    expect(input.guestCount).toBe(2);
  });

  it('prefills a newly added dish with the headcount', async () => {
    const user = userEvent.setup();
    // A standalone recipe whose own baseServings (2) differs from the headcount.
    setupListMock([listItem({ id: 50, name: 'Paella', baseServings: 2 })]);
    const onSave = vi.fn();
    render(
      <SlotEditorSheet
        open
        slot={{ ...RECIPE_SLOT, items: [] }}
        members={MEMBERS}
        isSaving={false}
        slots={[]}
        onClose={() => undefined}
        onSave={onSave}
      />,
    );
    // Headcount = 1 member + 3 guests = 4.
    await user.click(screen.getByRole('checkbox', { name: 'Conor' }));
    await user.clear(screen.getByLabelText('Number of guests'));
    await user.type(screen.getByLabelText('Number of guests'), '3');

    await user.click(screen.getByRole('combobox', { name: 'Add a dish' }));
    await user.click(await screen.findByText('Paella'));

    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalled();
    });
    const input = onSave.mock.calls[0]?.[0] as UpdateSlotInput;
    expect(input.items).toEqual([
      expect.objectContaining({ recipeId: 50, prepared: 4, eaten: 4 }),
    ]);
  });
});

describe('SlotEditorSheet — leftovers', () => {
  const EMPTY_SLOT: PlanSlot = {
    id: 9,
    planId: 1,
    date: '2026-06-17',
    occasionId: 2,
    occasionName: 'Dinner',
    slotType: 'empty',
    leftoversSource: null,
    chefUserId: null,
    comment: null,
    items: [],
    dinerUserIds: [],
    guestCount: 0,
  };

  // A Cooking slot dated before EMPTY_SLOT — its dish is a plan-meal option.
  const EARLIER_COOKING: PlanSlot = {
    id: 3,
    planId: 1,
    date: '2026-06-15',
    occasionId: 2,
    occasionName: 'Dinner',
    slotType: 'recipe',
    leftoversSource: null,
    chefUserId: null,
    comment: null,
    items: [
      eat({ recipeId: 10, recipeName: 'Tomato Pasta', prepared: 6, eaten: 6 }),
    ],
    dinerUserIds: [],
    guestCount: 0,
  };

  function renderLeftovers(onSave = vi.fn()): typeof onSave {
    render(
      <SlotEditorSheet
        open
        slot={EMPTY_SLOT}
        members={[]}
        isSaving={false}
        slots={[EARLIER_COOKING, EMPTY_SLOT]}
        onClose={() => undefined}
        onSave={onSave}
      />,
    );
    return onSave;
  }

  it('lists earlier cooking meals plus Takeaway and Other once Leftovers is picked', async () => {
    const user = userEvent.setup();
    renderLeftovers();
    await user.click(screen.getByText('Leftovers'));
    const select = screen.getByLabelText('Leftovers of which meal');
    const options = Array.from(
      select.querySelectorAll('option'),
      (o) => o.textContent,
    );
    expect(options).toEqual(
      expect.arrayContaining(['Tomato Pasta', 'Takeaway', 'Other']),
    );
  });

  it('does not offer the current or later slots as plan meals', async () => {
    const user = userEvent.setup();
    render(
      <SlotEditorSheet
        open
        slot={EARLIER_COOKING}
        members={[]}
        isSaving={false}
        // EARLIER_COOKING is the first slot — nothing is before it.
        slots={[EARLIER_COOKING, EMPTY_SLOT]}
        onClose={() => undefined}
        onSave={() => undefined}
      />,
    );
    await user.click(screen.getByText('Leftovers'));
    const select = screen.getByLabelText('Leftovers of which meal');
    expect(Array.from(select.querySelectorAll('optgroup'))).toHaveLength(0);
  });

  it('saves a plan-meal leftover as one eat item linked to the source recipe', async () => {
    const user = userEvent.setup();
    const onSave = renderLeftovers();
    await user.click(screen.getByText('Leftovers'));
    await user.selectOptions(
      screen.getByLabelText('Leftovers of which meal'),
      'recipe:10',
    );
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalled();
    });
    const input = onSave.mock.calls[0]?.[0] as UpdateSlotInput;
    expect(input.slotType).toBe('leftovers');
    expect(input.leftoversSource).toBe('plan_meal');
    expect(input.items).toEqual([
      expect.objectContaining({ recipeId: 10, prepared: 0, eaten: 6 }),
    ]);
  });

  it('saves a takeaway leftover as a bare marker with no items', async () => {
    const user = userEvent.setup();
    const onSave = renderLeftovers();
    await user.click(screen.getByText('Leftovers'));
    await user.selectOptions(
      screen.getByLabelText('Leftovers of which meal'),
      'takeaway',
    );
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalled();
    });
    const input = onSave.mock.calls[0]?.[0] as UpdateSlotInput;
    expect(input.slotType).toBe('leftovers');
    expect(input.leftoversSource).toBe('takeaway');
    expect(input.items).toEqual([]);
  });

  it('does not save while no leftovers source is chosen', async () => {
    const user = userEvent.setup();
    const onSave = renderLeftovers();
    await user.click(screen.getByText('Leftovers'));
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).not.toHaveBeenCalled();
  });

  // A variation of base 22 eaten earlier, with no base 22 cooked anywhere — so
  // eating its leftovers runs the (empty) base pool short.
  const EARLIER_VARIATION: PlanSlot = {
    ...EARLIER_COOKING,
    items: [
      eat({
        recipeId: 10,
        recipeName: 'Pasta',
        baseRecipeId: 22,
        prepared: 4,
        eaten: 4,
      }),
    ],
  };

  it('frames a non-base leftover shortfall around the meal, not the base', async () => {
    const user = userEvent.setup();
    render(
      <SlotEditorSheet
        open
        slot={EMPTY_SLOT}
        members={[]}
        isSaving={false}
        slots={[EARLIER_VARIATION, EMPTY_SLOT]}
        onClose={() => undefined}
        onSave={() => undefined}
      />,
    );
    await user.click(screen.getByText('Leftovers'));
    await user.selectOptions(
      screen.getByLabelText('Leftovers of which meal'),
      'recipe:10',
    );
    expect(screen.getByTestId('serving-variation-warning')).toHaveTextContent(
      'Not enough of this meal prepared',
    );
  });

  // A base eaten earlier with nothing cooked ahead — its leftover is a true
  // base-pool deficit, so it keeps the base wording.
  const EARLIER_BASE: PlanSlot = {
    ...EARLIER_COOKING,
    items: [
      cook({ recipeId: 22, recipeName: 'Base', prepared: 2 }),
      eat({
        recipeId: 22,
        recipeName: 'Base',
        isBase: true,
        prepared: 0,
        eaten: 2,
      }),
    ],
  };

  it('keeps the base wording for a leftover of a base', async () => {
    const user = userEvent.setup();
    render(
      <SlotEditorSheet
        open
        slot={EMPTY_SLOT}
        members={[]}
        isSaving={false}
        slots={[EARLIER_BASE, EMPTY_SLOT]}
        onClose={() => undefined}
        onSave={() => undefined}
      />,
    );
    await user.click(screen.getByText('Leftovers'));
    await user.selectOptions(
      screen.getByLabelText('Leftovers of which meal'),
      'recipe:22',
    );
    expect(screen.getByTestId('serving-variation-warning')).toHaveTextContent(
      'Not enough base cooked yet',
    );
  });
});
