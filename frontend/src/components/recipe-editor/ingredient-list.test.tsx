import type {
  RecipeIngredientLine,
  RecipeReferenceItem,
} from '@loftys-larder/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  IngredientList,
  type IngredientListProps,
  type IngredientPickerOption,
} from './ingredient-list.tsx';

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
    const ingredientInput = screen.getByLabelText('Ingredient for row 1');
    await user.click(ingredientInput);
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

  it('preselects the ingredient unit (display-only) from the picker', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('button', { name: 'Add ingredient' }));
    const ingredientInput = screen.getByLabelText('Ingredient for row 1');
    await user.click(ingredientInput);
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
    await user.click(screen.getByLabelText('Ingredient for row 1'));
    await user.click(await screen.findByRole('option', { name: 'Onion' }));
    await user.type(screen.getByLabelText('Quantity for row 1'), '50');
    await user.selectOptions(
      screen.getByLabelText('Prep type for row 1'),
      '21',
    );

    // Row 2: Onion, diced
    await user.click(screen.getByRole('button', { name: 'Add ingredient' }));
    await user.click(screen.getByLabelText('Ingredient for row 2'));
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
    await user.click(screen.getByLabelText('Ingredient for row 1'));
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
