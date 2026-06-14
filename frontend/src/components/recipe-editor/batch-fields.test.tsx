import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  BatchFields,
  type BatchFieldsValues,
  type RecipePickerOption,
} from './batch-fields.tsx';

interface RenderOptions {
  initial?: Partial<BatchFieldsValues>;
  baseRecipePartner?: Parameters<typeof BatchFields>[0]['baseRecipePartner'];
  pairedRecipePartner?: Parameters<
    typeof BatchFields
  >[0]['pairedRecipePartner'];
  searchBases?: ReturnType<typeof vi.fn>;
  searchPairs?: ReturnType<typeof vi.fn>;
  onSubmit?: ReturnType<typeof vi.fn>;
  errorMessage?: string | null;
}

function renderBatchFields(options: RenderOptions = {}): {
  onSubmit: ReturnType<typeof vi.fn>;
  searchBases: ReturnType<typeof vi.fn>;
  searchPairs: ReturnType<typeof vi.fn>;
} {
  const initial: BatchFieldsValues = {
    isBase: false,
    baseRecipeId: null,
    pairedRecipeId: null,
    ...options.initial,
  };
  const onSubmit = options.onSubmit ?? vi.fn(() => Promise.resolve());
  const searchBases =
    options.searchBases ??
    vi.fn((): Promise<RecipePickerOption[]> => Promise.resolve([]));
  const searchPairs =
    options.searchPairs ??
    vi.fn((): Promise<RecipePickerOption[]> => Promise.resolve([]));
  render(
    <BatchFields
      initial={initial}
      baseRecipePartner={options.baseRecipePartner ?? null}
      pairedRecipePartner={options.pairedRecipePartner ?? null}
      searchBases={searchBases}
      searchPairs={searchPairs}
      onSubmit={onSubmit}
      errorMessage={options.errorMessage ?? null}
    />,
  );
  return { onSubmit, searchBases, searchPairs };
}

describe('BatchFields', () => {
  it('renders the base + pair pickers by default and hides both when isBase is toggled on', async () => {
    renderBatchFields();
    expect(screen.getByLabelText('Search base recipes')).toBeInTheDocument();
    expect(screen.getByLabelText('Search paired recipes')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByLabelText(/this is a base recipe/i));

    expect(
      screen.queryByLabelText('Search base recipes'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText('Search paired recipes'),
    ).not.toBeInTheDocument();
  });

  it('clears an existing pair when isBase is toggled on', async () => {
    const { onSubmit } = renderBatchFields({
      initial: { isBase: false, baseRecipeId: null, pairedRecipeId: 5 },
      pairedRecipePartner: { id: 5, name: 'Sibling', isDeleted: false },
    });
    const user = userEvent.setup();
    await user.click(screen.getByLabelText(/this is a base recipe/i));
    await user.click(screen.getByRole('button', { name: 'Save batch fields' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({
      isBase: true,
      pairedRecipeId: null,
    });
  });

  it('omits unchanged fields from the submit payload', async () => {
    const { onSubmit } = renderBatchFields();
    const user = userEvent.setup();
    await user.click(screen.getByLabelText(/this is a base recipe/i));
    await user.click(screen.getByRole('button', { name: 'Save batch fields' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({ isBase: true });
  });

  it('does not call onSubmit when nothing has changed', async () => {
    const { onSubmit } = renderBatchFields();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Save batch fields' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows a (deleted) hint when the paired partner is soft-deleted', () => {
    renderBatchFields({
      initial: { isBase: false, baseRecipeId: null, pairedRecipeId: 99 },
      pairedRecipePartner: { id: 99, name: 'Lost Partner', isDeleted: true },
    });
    expect(screen.getByText(/Lost Partner \(deleted\)/i)).toBeInTheDocument();
  });

  it('surfaces an error message passed in by the parent', () => {
    renderBatchFields({ errorMessage: 'Pair self not allowed' });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Pair self not allowed',
    );
  });

  it('sends baseRecipeId in the payload when a base is picked', async () => {
    const searchBases = vi.fn(
      (): Promise<RecipePickerOption[]> =>
        Promise.resolve([{ id: 42, label: 'Bean Base' }]),
    );
    const { onSubmit } = renderBatchFields({ searchBases });
    const user = userEvent.setup();

    await user.click(screen.getByLabelText('Search base recipes'));
    await waitFor(() => {
      expect(searchBases).toHaveBeenCalled();
    });
    await user.click(await screen.findByRole('option', { name: 'Bean Base' }));
    await user.click(screen.getByRole('button', { name: 'Save batch fields' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({ baseRecipeId: 42 });
  });
});
