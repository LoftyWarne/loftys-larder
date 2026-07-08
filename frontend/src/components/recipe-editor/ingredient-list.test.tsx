import type {
  IngredientReferences,
  RecipeIngredientLine,
  RecipeReferenceItem,
} from '@loftys-larder/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TRPCClientError } from '@trpc/client';
import { describe, expect, it, vi } from 'vitest';

import {
  IngredientList,
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
      { ingredientId: 101, quantity: '50', unitId: 1, prepTypeId: null },
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
      { ingredientId: 101, quantity: '50', unitId: 1, prepTypeId: 21 },
      { ingredientId: 101, quantity: '30', unitId: 1, prepTypeId: 22 },
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

  it('rejects an invalid quantity and surfaces an inline error', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.click(screen.getByRole('button', { name: 'Add ingredient' }));
    await user.click(await screen.findByRole('option', { name: 'Onion' }));
    await user.type(
      screen.getByLabelText('Quantity for row 1'),
      'not-a-number',
    );

    await user.click(screen.getByRole('button', { name: 'Save ingredients' }));

    expect(
      await screen.findByText(/Quantity must be a non-negative number/i),
    ).toBeVisible();
    expect(onSubmit).not.toHaveBeenCalled();
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
    expect(createIngredient.mock.calls[0]?.[0]).toEqual({
      name: 'Carrot',
      categoryId: 5,
      defaultUnitId: 1,
      isPlant: false,
      averageShelfLifeDays: null,
    });

    // Dialog closes and the new ingredient is selected for the row.
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
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
      { ingredientId: 201, quantity: '2', unitId: 1, prepTypeId: null },
    ]);
  });

  it('clears the typed text from the row when the create dialog is cancelled', async () => {
    const user = userEvent.setup();
    const createIngredient = vi.fn();
    setup({ references: REFERENCES, createIngredient });

    await user.click(screen.getByRole('button', { name: 'Add ingredient' }));
    await user.click(screen.getByLabelText('Ingredient for row 1'));
    await user.type(screen.getByLabelText('Ingredient for row 1'), 'Carrot');

    await user.click(
      await screen.findByRole('option', { name: /Create .*Carrot/ }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
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
      },
    ];
    setup({
      initialLines: initial,
      serverErrors: [{ index: 0, message: 'Expected g, got piece' }],
    });
    expect(screen.getByText('Expected g, got piece')).toBeVisible();
  });
});
