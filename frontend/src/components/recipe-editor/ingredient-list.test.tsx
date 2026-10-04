import type {
  IngredientReferences,
  RecipeImportProposedIngredient,
  RecipeIngredientLine,
  RecipeReferenceItem,
} from '@loftys-larder/shared';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TRPCClientError } from '@trpc/client';
import { describe, expect, it, vi } from 'vitest';

import { suppressActNoise } from '@/test/act-noise.ts';

import {
  IngredientList,
  type IngredientDraftLine,
  type IngredientListProps,
  type IngredientPickerOption,
} from './ingredient-list.tsx';

const REFERENCES: IngredientReferences = {
  categories: [{ id: 5, name: 'Vegetables' }],
  units: [{ id: 1, name: 'g' }],
};

function makeTrpcError(cause: { code: string }): TRPCClientError<never> {
  const err = new TRPCClientError<never>('boom');
  Object.assign(err, { shape: { data: { cause } } });
  return err;
}

const PREP_TYPES: RecipeReferenceItem[] = [
  { id: 21, name: 'chopped' },
  { id: 22, name: 'diced' },
];

const ONION: IngredientPickerOption = {
  id: 101,
  label: 'Onion',
  defaultUnitId: 1,
  unitName: 'g',
};
const GARLIC: IngredientPickerOption = {
  id: 102,
  label: 'Garlic',
  defaultUnitId: 1,
  unitName: 'g',
};

function defaultSearch(q: string): readonly IngredientPickerOption[] {
  const lowered = q.toLowerCase();
  return [ONION, GARLIC].filter((o) => o.label.toLowerCase().includes(lowered));
}

function setup(overrides: Partial<IngredientListProps> = {}): {
  onSubmit: ReturnType<typeof vi.fn>;
} {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(
    <IngredientList
      initialLines={[]}
      prepTypes={PREP_TYPES}
      searchIngredients={defaultSearch}
      onSubmit={onSubmit}
      {...overrides}
    />,
  );
  return { onSubmit };
}

describe('IngredientList', () => {
  it('adds a line, picks an ingredient, and submits the payload', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.click(screen.getByRole('button', { name: 'Add ingredient' }));
    await user.click(await screen.findByRole('option', { name: 'Onion' }));
    await user.type(screen.getByLabelText('Quantity for row 1'), '50');

    await user.click(screen.getByRole('button', { name: 'Save ingredients' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit.mock.calls[0]?.[0]).toEqual([
      {
        ingredientId: 101,
        quantity: '50',
        unitId: 1,
        prepTypeId: null,
        isOptional: false,
      },
    ]);
  });

  it('submits the optional flag for a ticked line', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.click(screen.getByRole('button', { name: 'Add ingredient' }));
    await user.click(await screen.findByRole('option', { name: 'Onion' }));
    await user.type(screen.getByLabelText('Quantity for row 1'), '50');
    await user.click(
      screen.getByRole('checkbox', { name: 'Optional for row 1' }),
    );

    await user.click(screen.getByRole('button', { name: 'Save ingredients' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit.mock.calls[0]?.[0]).toEqual([
      {
        ingredientId: 101,
        quantity: '50',
        unitId: 1,
        prepTypeId: null,
        isOptional: true,
      },
    ]);
  });

  it('seeds the optional toggle from saved lines and old drafts', () => {
    setup({
      initialDraftLines: [
        {
          ingredient: ONION,
          quantity: '50',
          prepTypeId: null,
          isOptional: true,
        },
        // Drafts saved before the flag existed carry no `isOptional`.
        { ingredient: GARLIC, quantity: '10', prepTypeId: null },
      ],
    });

    expect(
      screen.getByRole('checkbox', { name: 'Optional for row 1' }),
    ).toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: 'Optional for row 2' }),
    ).not.toBeChecked();
  });

  it('includes the optional flag in autosave snapshots', async () => {
    const user = userEvent.setup();
    const onLinesChange = vi.fn();
    setup({
      initialDraftLines: [
        {
          ingredient: ONION,
          quantity: '50',
          prepTypeId: null,
          isOptional: false,
        },
      ],
      onLinesChange,
    });

    await user.click(
      screen.getByRole('checkbox', { name: 'Optional for row 1' }),
    );

    expect(onLinesChange).toHaveBeenLastCalledWith([
      expect.objectContaining({
        ingredient: ONION,
        quantity: '50',
        prepTypeId: null,
        isOptional: true,
      }),
    ]);
  });

  it('focuses the new ingredient row after clicking Add ingredient', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('button', { name: 'Add ingredient' }));

    expect(screen.getByLabelText('Ingredient for row 1')).toHaveFocus();
  });

  it('disables Add ingredient until the preceding row is complete', async () => {
    const user = userEvent.setup();
    setup();
    const addButton = screen.getByRole('button', { name: 'Add ingredient' });

    // Enabled from the empty state — nothing precedes the first row.
    expect(addButton).toBeEnabled();

    await user.click(addButton);
    // A fresh, empty row is incomplete, so no further rows can be added.
    expect(addButton).toBeDisabled();

    await user.click(await screen.findByRole('option', { name: 'Onion' }));
    // Ingredient picked but quantity still missing.
    expect(addButton).toBeDisabled();

    await user.type(screen.getByLabelText('Quantity for row 1'), '50');
    expect(addButton).toBeEnabled();
  });

  it('explains via a tooltip why Add ingredient is disabled', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('button', { name: 'Add ingredient' }));
    const addButton = screen.getByRole('button', { name: 'Add ingredient' });
    expect(addButton).toBeDisabled();

    // The disabled button has `pointer-events-none`, so hover the wrapper the
    // tooltip trigger sits on.
    const trigger = addButton.parentElement;
    if (!trigger) throw new Error('expected a tooltip trigger wrapper');
    await user.hover(trigger);

    expect(
      await screen.findByRole('tooltip', {
        name: /Give each ingredient a name and quantity/i,
      }),
    ).toBeInTheDocument();
  });

  it('switches the tooltip to the duplicate reason when a row repeats', async () => {
    const user = userEvent.setup();
    setup();

    // Row 1: Onion, no prep.
    await user.click(screen.getByRole('button', { name: 'Add ingredient' }));
    await user.click(await screen.findByRole('option', { name: 'Onion' }));
    await user.type(screen.getByLabelText('Quantity for row 1'), '50');

    // Row 2: Onion again with the same prep — the duplicate now drives the gate.
    await user.click(screen.getByRole('button', { name: 'Add ingredient' }));
    await user.click(await screen.findByRole('option', { name: 'Onion' }));

    const addButton = screen.getByRole('button', { name: 'Add ingredient' });
    expect(addButton).toBeDisabled();
    const trigger = addButton.parentElement;
    if (!trigger) throw new Error('expected a tooltip trigger wrapper');
    await user.hover(trigger);

    expect(
      await screen.findByRole('tooltip', {
        name: /Resolve the duplicate ingredient/i,
      }),
    ).toBeInTheDocument();
  });

  it('preselects the ingredient unit (display-only) from the picker', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('button', { name: 'Add ingredient' }));
    await user.click(await screen.findByRole('option', { name: 'Onion' }));

    // The "g" cell renders next to the row; assert it's present once selected.
    expect(screen.getByText('g')).toBeInTheDocument();
  });

  it('removes a line on click', async () => {
    const user = userEvent.setup();
    const initial: RecipeIngredientLine[] = [
      {
        id: 1,
        ingredientId: 101,
        ingredientName: 'Onion',
        quantity: '50',
        unitId: 1,
        unitName: 'g',
        prepTypeId: null,
        prepTypeName: null,
        isPlant: true,
        isOptional: false,
      },
    ];
    const { onSubmit } = setup({ initialLines: initial });

    await user.click(screen.getByRole('button', { name: 'Remove row 1' }));
    await user.click(screen.getByRole('button', { name: 'Save ingredients' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith([]);
    });
  });

  it('allows duplicate ingredient ids with different prep types', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    // Row 1: Onion, chopped
    await user.click(screen.getByRole('button', { name: 'Add ingredient' }));
    await user.click(await screen.findByRole('option', { name: 'Onion' }));
    await user.type(screen.getByLabelText('Quantity for row 1'), '50');
    await user.selectOptions(
      screen.getByLabelText('Prep type for row 1'),
      '21',
    );

    // Row 2: Onion, diced
    await user.click(screen.getByRole('button', { name: 'Add ingredient' }));
    await user.click(await screen.findByRole('option', { name: 'Onion' }));
    await user.type(screen.getByLabelText('Quantity for row 2'), '30');
    await user.selectOptions(
      screen.getByLabelText('Prep type for row 2'),
      '22',
    );

    await user.click(screen.getByRole('button', { name: 'Save ingredients' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit.mock.calls[0]?.[0]).toEqual([
      {
        ingredientId: 101,
        quantity: '50',
        unitId: 1,
        prepTypeId: 21,
        isOptional: false,
      },
      {
        ingredientId: 101,
        quantity: '30',
        unitId: 1,
        prepTypeId: 22,
        isOptional: false,
      },
    ]);
  });

  it('blocks an exact duplicate ingredient + prep line', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    // Row 1: Onion, no prep.
    await user.click(screen.getByRole('button', { name: 'Add ingredient' }));
    await user.click(await screen.findByRole('option', { name: 'Onion' }));
    await user.type(screen.getByLabelText('Quantity for row 1'), '50');

    // Row 2: Onion again with the same (default) prep — an exact duplicate.
    await user.click(screen.getByRole('button', { name: 'Add ingredient' }));
    await user.click(await screen.findByRole('option', { name: 'Onion' }));

    // Flagged as soon as it occurs, before any save attempt.
    expect(
      await screen.findByText(/already in the list with the same prep type/i),
    ).toBeVisible();
    // And it gates adding further rows.
    expect(
      screen.getByRole('button', { name: 'Add ingredient' }),
    ).toBeDisabled();

    await user.type(screen.getByLabelText('Quantity for row 2'), '30');
    await user.click(screen.getByRole('button', { name: 'Save ingredients' }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits an empty array when all lines are removed', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.click(screen.getByRole('button', { name: 'Save ingredients' }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith([]);
    });
  });

  it('strips non-numeric characters from the quantity as typed', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('button', { name: 'Add ingredient' }));
    const qty = screen.getByLabelText('Quantity for row 1');
    await user.type(qty, '1a2b/3c');

    // Letters gone; the single slash kept.
    expect(qty).toHaveValue('12/3');
  });

  it('shows the quantity error on blur, not while typing a fraction', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('button', { name: 'Add ingredient' }));
    const qty = screen.getByLabelText('Quantity for row 1');

    // A partially-typed fraction must not flash an error mid-entry.
    await user.type(qty, '1/');
    expect(screen.queryByText(/number or simple fraction/i)).toBeNull();

    // Blurring an incomplete/invalid value surfaces it.
    await user.tab();
    expect(screen.getByText(/number or simple fraction/i)).toBeVisible();

    // Correcting the value clears the error, without flashing while typing.
    await user.clear(qty);
    await user.type(qty, '1/2');
    expect(screen.queryByText(/number or simple fraction/i)).toBeNull();
  });

  it('rejects an invalid quantity and surfaces an inline error', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.click(screen.getByRole('button', { name: 'Add ingredient' }));
    await user.click(await screen.findByRole('option', { name: 'Onion' }));
    // Sanitised to a well-formed shape but an invalid fraction (÷0).
    await user.type(screen.getByLabelText('Quantity for row 1'), '1/0');

    await user.click(screen.getByRole('button', { name: 'Save ingredients' }));

    expect(await screen.findByText(/number or simple fraction/i)).toBeVisible();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('trims trailing zeros from a saved quantity on load', () => {
    const initial: RecipeIngredientLine[] = [
      {
        id: 1,
        ingredientId: 101,
        ingredientName: 'Onion',
        quantity: '50.000',
        unitId: 1,
        unitName: 'g',
        prepTypeId: null,
        prepTypeName: null,
        isPlant: true,
        isOptional: false,
      },
    ];
    setup({ initialLines: initial });

    expect(screen.getByLabelText('Quantity for row 1')).toHaveValue('50');
  });

  it('converts a fraction quantity to a decimal in the payload', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.click(screen.getByRole('button', { name: 'Add ingredient' }));
    await user.click(await screen.findByRole('option', { name: 'Onion' }));
    await user.type(screen.getByLabelText('Quantity for row 1'), '1/2');

    await user.click(screen.getByRole('button', { name: 'Save ingredients' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit.mock.calls[0]?.[0]).toEqual([
      {
        ingredientId: 101,
        quantity: '0.5',
        unitId: 1,
        prepTypeId: null,
        isOptional: false,
      },
    ]);
  });

  it('creates an ingredient inline and selects it into the row', async () => {
    const user = userEvent.setup();
    const createIngredient = vi.fn().mockResolvedValue({
      id: 201,
      label: 'Carrot',
      defaultUnitId: 1,
      unitName: 'g',
    } satisfies IngredientPickerOption);
    const { onSubmit } = setup({
      references: REFERENCES,
      createIngredient,
    });

    await user.click(screen.getByRole('button', { name: 'Add ingredient' }));
    const ingredientInput = screen.getByLabelText('Ingredient for row 1');
    await user.click(ingredientInput);
    await user.type(ingredientInput, 'Carrot');

    // The dialog is opened, driven, and closed by clicks — see suppressActNoise.
    await suppressActNoise(async () => {
      await user.click(
        await screen.findByRole('option', { name: /Create .*Carrot/ }),
      );

      // The create dialog opens, prefilled with the typed name.
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByLabelText('Name')).toHaveValue('Carrot');
      await user.click(
        within(dialog).getByRole('button', { name: 'Create ingredient' }),
      );

      await waitFor(() => {
        expect(createIngredient).toHaveBeenCalledTimes(1);
      });

      // Dialog closes and the new ingredient is selected for the row.
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
    });

    expect(createIngredient.mock.calls[0]?.[0]).toEqual({
      name: 'Carrot',
      categoryId: 5,
      defaultUnitId: 1,
      isPlant: false,
      averageShelfLifeDays: null,
    });
    expect(ingredientInput).toHaveValue('Carrot');
    // The create-form submit must not bubble to the outer ingredients form and
    // trip its quantity validation (React events propagate through portals).
    expect(
      screen.queryByText(/Quantity must be a non-negative number/i),
    ).toBeNull();

    await user.type(screen.getByLabelText('Quantity for row 1'), '2');
    await user.click(screen.getByRole('button', { name: 'Save ingredients' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit.mock.calls[0]?.[0]).toEqual([
      {
        ingredientId: 201,
        quantity: '2',
        unitId: 1,
        prepTypeId: null,
        isOptional: false,
      },
    ]);
  });

  it('clears the typed text from the row when the create dialog is cancelled', async () => {
    const user = userEvent.setup();
    const createIngredient = vi.fn();
    setup({ references: REFERENCES, createIngredient });

    await user.click(screen.getByRole('button', { name: 'Add ingredient' }));
    await user.click(screen.getByLabelText('Ingredient for row 1'));
    await user.type(screen.getByLabelText('Ingredient for row 1'), 'Carrot');

    await suppressActNoise(async () => {
      await user.click(
        await screen.findByRole('option', { name: /Create .*Carrot/ }),
      );
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
    });

    expect(createIngredient).not.toHaveBeenCalled();
    // The remounted combobox is empty again.
    expect(screen.getByLabelText('Ingredient for row 1')).toHaveValue('');
  });

  it('surfaces INGREDIENT_NAME_TAKEN on the create form', async () => {
    const user = userEvent.setup();
    const createIngredient = vi
      .fn()
      .mockRejectedValue(makeTrpcError({ code: 'INGREDIENT_NAME_TAKEN' }));
    setup({ references: REFERENCES, createIngredient });

    await user.click(screen.getByRole('button', { name: 'Add ingredient' }));
    const ingredientInput = screen.getByLabelText('Ingredient for row 1');
    await user.click(ingredientInput);
    await user.type(ingredientInput, 'Leek');

    await suppressActNoise(async () => {
      await user.click(
        await screen.findByRole('option', { name: /Create .*Leek/ }),
      );
      const dialog = await screen.findByRole('dialog');
      await user.click(
        within(dialog).getByRole('button', { name: 'Create ingredient' }),
      );

      expect(
        await within(dialog).findByText(
          'An ingredient with this name already exists',
        ),
      ).toBeVisible();
    });
  });

  it('does not offer inline create without references or a create handler', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('button', { name: 'Add ingredient' }));
    const ingredientInput = screen.getByLabelText('Ingredient for row 1');
    await user.click(ingredientInput);
    await user.type(ingredientInput, 'Carrot');

    expect(await screen.findByText('No matches')).toBeVisible();
    expect(screen.queryByRole('option', { name: /Create/ })).toBeNull();
  });

  it('renders server-side line errors next to the offending row', () => {
    const initial: RecipeIngredientLine[] = [
      {
        id: 1,
        ingredientId: 101,
        ingredientName: 'Onion',
        quantity: '50',
        unitId: 1,
        unitName: 'g',
        prepTypeId: null,
        prepTypeName: null,
        isPlant: true,
        isOptional: false,
      },
    ];
    setup({
      initialLines: initial,
      serverErrors: [{ index: 0, message: 'Expected g, got piece' }],
    });
    expect(screen.getByText('Expected g, got piece')).toBeVisible();
  });

  it('clears the "Saved." notice once a line is edited', async () => {
    const user = userEvent.setup();
    const initial: RecipeIngredientLine[] = [
      {
        id: 1,
        ingredientId: 101,
        ingredientName: 'Onion',
        quantity: '50',
        unitId: 1,
        unitName: 'g',
        prepTypeId: null,
        prepTypeName: null,
        isPlant: true,
        isOptional: false,
      },
    ];
    const { rerender } = render(
      <IngredientList
        initialLines={initial}
        prepTypes={PREP_TYPES}
        searchIngredients={defaultSearch}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    // No notice before a save.
    expect(screen.queryByText('Saved.')).toBeNull();

    // The page bumps `savedNoticeKey` when a save lands.
    rerender(
      <IngredientList
        initialLines={initial}
        prepTypes={PREP_TYPES}
        searchIngredients={defaultSearch}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        savedNoticeKey={Date.now()}
      />,
    );
    expect(screen.getByText('Saved.')).toBeVisible();

    // Editing a line marks the section dirty — the stale notice must go.
    await user.clear(screen.getByLabelText('Quantity for row 1'));
    await user.type(screen.getByLabelText('Quantity for row 1'), '75');
    expect(screen.queryByText('Saved.')).toBeNull();
  });
  it('keeps a saved row key, and never gives a new row a saved key', async () => {
    const user = userEvent.setup();
    const onLinesChange = vi.fn();
    setup({
      initialDraftLines: [
        {
          key: 'new-50',
          ingredient: ONION,
          quantity: '50',
          prepTypeId: null,
          isOptional: false,
        },
      ],
      onLinesChange,
    });

    await user.click(screen.getByRole('button', { name: 'Add ingredient' }));

    const [lines] = onLinesChange.mock.lastCall as [IngredientDraftLine[]];
    expect(lines[0]?.key).toBe('new-50');
    expect(lines[1]?.key).toBeDefined();
    expect(lines[1]?.key).not.toBe('new-50');
  });

  // Import Review (DEC-105): a row can point at a proposed new ingredient.
  describe('proposed ingredients', () => {
    const PROPOSED: RecipeImportProposedIngredient = {
      key: 'n1',
      name: 'Black pepper',
      categoryId: null,
      defaultUnitId: 1,
      isPlant: true,
      averageShelfLifeDays: null,
    };
    const PROPOSED_REFERENCES: IngredientReferences = {
      categories: [{ id: 3, name: 'Spices' }],
      units: [{ id: 1, name: 'g' }],
    };

    function setupProposed(overrides: Partial<IngredientListProps> = {}): {
      onSubmit: ReturnType<typeof vi.fn>;
    } {
      return setup({
        initialDraftLines: [
          {
            key: 'i2',
            ingredient: null,
            newKey: 'n1',
            quantity: '2',
            prepTypeId: null,
            isOptional: false,
          },
        ],
        proposedIngredients: new Map([['n1', PROPOSED]]),
        references: PROPOSED_REFERENCES,
        proposeIngredient: vi.fn(() => 'c1'),
        ...overrides,
      });
    }

    it('shows the row as new, with its details editable in place', async () => {
      const onProposedIngredientChange = vi.fn();
      const user = userEvent.setup();
      setupProposed({ onProposedIngredientChange });

      expect(screen.getByText('New')).toBeInTheDocument();
      expect(
        screen.getByLabelText('New ingredient name for row 1'),
      ).toHaveValue('Black pepper');
      expect(
        screen.getByLabelText('Unit for the new ingredient in row 1'),
      ).toHaveValue('1');

      await user.selectOptions(
        screen.getByLabelText('Category for the new ingredient in row 1'),
        'Spices',
      );
      expect(onProposedIngredientChange).toHaveBeenCalledWith('n1', {
        categoryId: 3,
      });
    });

    it('blocks submit until the proposed ingredient is complete', async () => {
      const { onSubmit } = setupProposed({ hideSaveButton: true });

      expect(
        screen.queryByRole('button', { name: 'Save ingredients' }),
      ).not.toBeInTheDocument();
      fireEvent.submit(screen.getByRole('form', { name: 'Ingredients' }));

      expect(await screen.findByText('Choose a category')).toBeInTheDocument();
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('switches the row to an existing ingredient through the combobox', async () => {
      const onProposedReplaced = vi.fn();
      const onLinesChange = vi.fn();
      const user = userEvent.setup();
      setupProposed({ onProposedReplaced, onLinesChange });

      await user.click(
        screen.getByLabelText('Use an existing ingredient for row 1'),
      );
      await user.click(await screen.findByRole('option', { name: 'Onion' }));

      expect(onProposedReplaced).toHaveBeenCalledWith('n1', ONION.id, false);
      expect(screen.getByLabelText('Ingredient for row 1')).toHaveValue(
        'Onion',
      );
      const [lines] = onLinesChange.mock.lastCall as [IngredientDraftLine[]];
      expect(lines[0]?.newKey).toBeUndefined();
      expect(lines[0]?.ingredient).toEqual(ONION);
    });

    it('proposes an ingredient for a name that isn’t in the list', async () => {
      const proposeIngredient = vi.fn(() => 'c1');
      const user = userEvent.setup();
      setup({
        proposedIngredients: new Map([
          ['c1', { ...PROPOSED, key: 'c1', name: 'Basil' }],
        ]),
        references: PROPOSED_REFERENCES,
        proposeIngredient,
      });

      await user.click(screen.getByRole('button', { name: 'Add ingredient' }));
      await user.type(screen.getByLabelText('Ingredient for row 1'), 'Basil');
      await user.click(
        await screen.findByRole('option', { name: 'New ingredient “Basil”' }),
      );

      expect(proposeIngredient).toHaveBeenCalledWith('Basil');
      expect(
        screen.getByLabelText('New ingredient name for row 1'),
      ).toHaveValue('Basil');
    });

    it('shows the original line and a note on the quantity', () => {
      setupProposed({
        originalLines: new Map([['i2', 'Black pepper to taste']]),
        quantityNotes: new Map([['i2', <span key="n">Amount guessed</span>]]),
      });

      expect(screen.getByText('Black pepper to taste')).toBeInTheDocument();
      expect(
        screen.getByLabelText('Quantity for row 1'),
      ).toHaveAccessibleDescription('Amount guessed');
    });
  });
});
