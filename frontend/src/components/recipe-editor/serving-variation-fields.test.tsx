import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  ServingVariationFields,
  type ServingVariationFieldsValues,
  type RecipePickerOption,
} from './serving-variation-fields.tsx';

interface RenderOptions {
  initial?: Partial<ServingVariationFieldsValues>;
  baseRecipePartner?: Parameters<
    typeof ServingVariationFields
  >[0]['baseRecipePartner'];
  searchBases?: ReturnType<typeof vi.fn>;
  onSubmit?: ReturnType<typeof vi.fn>;
  errorMessage?: string | null;
}

function renderServingVariationFields(options: RenderOptions = {}): {
  onSubmit: ReturnType<typeof vi.fn>;
  searchBases: ReturnType<typeof vi.fn>;
} {
  const initial: ServingVariationFieldsValues = {
    isBase: false,
    baseRecipeId: null,
    ...options.initial,
  };
  const onSubmit = options.onSubmit ?? vi.fn(() => Promise.resolve());
  const searchBases =
    options.searchBases ??
    vi.fn((): Promise<RecipePickerOption[]> => Promise.resolve([]));
  render(
    <ServingVariationFields
      initial={initial}
      baseRecipePartner={options.baseRecipePartner ?? null}
      searchBases={searchBases}
      onSubmit={onSubmit}
      errorMessage={options.errorMessage ?? null}
    />,
  );
  return { onSubmit, searchBases };
}

describe('ServingVariationFields', () => {
  it('renders the base picker by default and hides it when isBase is toggled on', async () => {
    renderServingVariationFields();
    expect(screen.getByLabelText('Search base recipes')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByLabelText(/this is a base recipe/i));

    expect(
      screen.queryByLabelText('Search base recipes'),
    ).not.toBeInTheDocument();
  });

  it('clears an existing base when isBase is toggled on', async () => {
    const { onSubmit } = renderServingVariationFields({
      initial: { isBase: false, baseRecipeId: 5 },
      baseRecipePartner: { id: 5, name: 'Bean Base', isDeleted: false },
    });
    const user = userEvent.setup();
    await user.click(screen.getByLabelText(/this is a base recipe/i));
    await user.click(
      screen.getByRole('button', { name: 'Save serving variation' }),
    );

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({
      isBase: true,
      baseRecipeId: null,
    });
  });

  it('omits unchanged fields from the submit payload', async () => {
    const { onSubmit } = renderServingVariationFields();
    const user = userEvent.setup();
    await user.click(screen.getByLabelText(/this is a base recipe/i));
    await user.click(
      screen.getByRole('button', { name: 'Save serving variation' }),
    );

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({ isBase: true });
  });

  it('does not call onSubmit when nothing has changed', async () => {
    const { onSubmit } = renderServingVariationFields();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole('button', { name: 'Save serving variation' }),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows a (deleted) hint when the base partner is soft-deleted', () => {
    renderServingVariationFields({
      initial: { isBase: false, baseRecipeId: 99 },
      baseRecipePartner: { id: 99, name: 'Lost Base', isDeleted: true },
    });
    expect(screen.getByText(/Lost Base \(deleted\)/i)).toBeInTheDocument();
  });

  it('surfaces an error message passed in by the parent', () => {
    renderServingVariationFields({ errorMessage: 'Base not allowed' });
    expect(screen.getByRole('alert')).toHaveTextContent('Base not allowed');
  });

  it('sends baseRecipeId in the payload when a base is picked', async () => {
    const searchBases = vi.fn(
      (): Promise<RecipePickerOption[]> =>
        Promise.resolve([{ id: 42, label: 'Bean Base' }]),
    );
    const { onSubmit } = renderServingVariationFields({ searchBases });
    const user = userEvent.setup();

    await user.click(screen.getByLabelText('Search base recipes'));
    await waitFor(() => {
      expect(searchBases).toHaveBeenCalled();
    });
    await user.click(await screen.findByRole('option', { name: 'Bean Base' }));
    await user.click(
      screen.getByRole('button', { name: 'Save serving variation' }),
    );

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({ baseRecipeId: 42 });
  });

  it('clears the "Saved." notice once a field is changed', async () => {
    const user = userEvent.setup();
    const initial: ServingVariationFieldsValues = {
      isBase: false,
      baseRecipeId: null,
    };
    const searchBases = vi.fn(
      (): Promise<RecipePickerOption[]> => Promise.resolve([]),
    );
    const props = {
      initial,
      baseRecipePartner: null,
      searchBases,
      onSubmit: vi.fn(() => Promise.resolve(true)),
      errorMessage: null,
    };
    const { rerender } = render(<ServingVariationFields {...props} />);

    expect(screen.queryByText('Saved.')).toBeNull();

    // The page bumps `savedNoticeKey` when a save lands.
    rerender(<ServingVariationFields {...props} savedNoticeKey={Date.now()} />);
    expect(screen.getByText('Saved.')).toBeVisible();

    // Toggling a field marks the section dirty — the stale notice must go.
    await user.click(screen.getByLabelText(/this is a base recipe/i));
    expect(screen.queryByText('Saved.')).toBeNull();
  });
});
