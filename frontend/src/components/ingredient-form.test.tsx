import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  IngredientForm,
  type IngredientFormProps,
} from './ingredient-form.tsx';

const FIRST_CATEGORY = { id: 1, name: 'Fruit & Veg' };
const FIRST_UNIT = { id: 10, name: 'g' };

const REFERENCES = {
  categories: [FIRST_CATEGORY, { id: 2, name: 'Pantry' }],
  units: [FIRST_UNIT, { id: 11, name: 'piece' }],
};

function renderForm(overrides: Partial<IngredientFormProps> = {}): {
  onSubmit: ReturnType<typeof vi.fn>;
  onCancel: ReturnType<typeof vi.fn>;
} {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();
  render(
    <IngredientForm
      references={REFERENCES}
      defaultValues={{
        name: '',
        categoryId: FIRST_CATEGORY.id,
        defaultUnitId: FIRST_UNIT.id,
        isPlant: false,
        averageShelfLifeDays: null,
      }}
      onSubmit={onSubmit}
      onCancel={onCancel}
      submitLabel="Add ingredient"
      {...overrides}
    />,
  );
  return { onSubmit, onCancel };
}

describe('IngredientForm', () => {
  it('submits trimmed values to onSubmit', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();

    await user.type(screen.getByLabelText('Name'), '  Onion  ');
    await user.selectOptions(screen.getByLabelText('Category'), '2');
    await user.selectOptions(screen.getByLabelText('Default unit'), '11');
    await user.type(screen.getByLabelText(/average shelf life/i), '30');
    await user.click(screen.getByLabelText(/counts towards plant points/i));
    await user.click(screen.getByRole('button', { name: /add ingredient/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        name: 'Onion',
        categoryId: 2,
        defaultUnitId: 11,
        isPlant: true,
        averageShelfLifeDays: 30,
      });
    });
  });

  it('surfaces a server-provided name error', async () => {
    renderForm({ nameError: 'An ingredient with this name already exists' });
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/already exists/i);
    });
  });

  it('rejects empty name on submit', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    await user.click(screen.getByRole('button', { name: /add ingredient/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/name is required/i);
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('rejects negative shelf life', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    await user.type(screen.getByLabelText('Name'), 'Onion');
    await user.type(screen.getByLabelText(/average shelf life/i), '-5');
    await user.click(screen.getByRole('button', { name: /add ingredient/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/at least 1 day/i);
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('invokes onCancel when cancel is clicked', async () => {
    const user = userEvent.setup();
    const { onCancel } = renderForm();
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
