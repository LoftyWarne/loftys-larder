import type { IngredientListItem } from '@loftys-larder/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TRPCClientError } from '@trpc/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  referencesUseQueryMock,
  listUseQueryMock,
  createUseMutationMock,
  updateUseMutationMock,
  deleteUseMutationMock,
  useUtilsMock,
} = vi.hoisted(() => ({
  referencesUseQueryMock: vi.fn(),
  listUseQueryMock: vi.fn(),
  createUseMutationMock: vi.fn(),
  updateUseMutationMock: vi.fn(),
  deleteUseMutationMock: vi.fn(),
  useUtilsMock: vi.fn(),
}));

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    ingredients: {
      references: { useQuery: referencesUseQueryMock },
      list: { useQuery: listUseQueryMock },
      create: { useMutation: createUseMutationMock },
      update: { useMutation: updateUseMutationMock },
      delete: { useMutation: deleteUseMutationMock },
    },
    useUtils: useUtilsMock,
  },
}));

import { IngredientsPage } from './ingredients-page.tsx';

const REFERENCES = {
  categories: [
    { id: 1, name: 'Fruit & Veg' },
    { id: 2, name: 'Pantry' },
  ],
  units: [
    { id: 10, name: 'g' },
    { id: 11, name: 'piece' },
  ],
};

const ONION: IngredientListItem = {
  id: 100,
  name: 'Onion',
  categoryId: 1,
  categoryName: 'Fruit & Veg',
  defaultUnitId: 10,
  defaultUnitName: 'g',
  isPlant: true,
  averageShelfLifeDays: 30,
};

const CARROT: IngredientListItem = {
  id: 101,
  name: 'Carrot',
  categoryId: 1,
  categoryName: 'Fruit & Veg',
  defaultUnitId: 10,
  defaultUnitName: 'g',
  isPlant: true,
  averageShelfLifeDays: null,
};

interface SetupOptions {
  list?: IngredientListItem[];
  createMutation?: ReturnType<typeof vi.fn>;
  updateMutation?: ReturnType<typeof vi.fn>;
  deleteMutation?: ReturnType<typeof vi.fn>;
}

interface SetupResult {
  mutateAsyncCreate: ReturnType<typeof vi.fn>;
  mutateAsyncUpdate: ReturnType<typeof vi.fn>;
  mutateAsyncDelete: ReturnType<typeof vi.fn>;
}

function setup(options: SetupOptions = {}): SetupResult {
  referencesUseQueryMock.mockReturnValue({
    data: REFERENCES,
    isLoading: false,
    error: null,
  });
  listUseQueryMock.mockReturnValue({
    data: options.list ?? [ONION, CARROT],
    isLoading: false,
    error: null,
  });
  const listInvalidate = vi.fn().mockResolvedValue(undefined);
  useUtilsMock.mockReturnValue({
    ingredients: { list: { invalidate: listInvalidate } },
  });

  const mutateAsyncCreate =
    options.createMutation ?? vi.fn().mockResolvedValue(ONION);
  const mutateAsyncUpdate =
    options.updateMutation ?? vi.fn().mockResolvedValue(ONION);
  const mutateAsyncDelete =
    options.deleteMutation ?? vi.fn().mockResolvedValue({ id: ONION.id });
  createUseMutationMock.mockReturnValue({ mutateAsync: mutateAsyncCreate });
  updateUseMutationMock.mockReturnValue({ mutateAsync: mutateAsyncUpdate });
  deleteUseMutationMock.mockReturnValue({
    mutateAsync: mutateAsyncDelete,
    isPending: false,
  });

  return { mutateAsyncCreate, mutateAsyncUpdate, mutateAsyncDelete };
}

function makeTrpcError(cause: { code: string }): TRPCClientError<never> {
  const err = new TRPCClientError<never>('boom');
  Object.assign(err, { shape: { data: { cause } } });
  return err;
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent === label,
  );
  if (!button) throw new Error(`No '${label}' button found in container`);
  return button;
}

beforeEach(() => {
  referencesUseQueryMock.mockReset();
  listUseQueryMock.mockReset();
  createUseMutationMock.mockReset();
  updateUseMutationMock.mockReset();
  deleteUseMutationMock.mockReset();
  useUtilsMock.mockReset();
});

describe('IngredientsPage', () => {
  it('renders a row per ingredient with category, unit, and plant marker', () => {
    setup();
    render(<IngredientsPage />);
    expect(screen.getByText('Onion')).toBeInTheDocument();
    expect(screen.getByText('Carrot')).toBeInTheDocument();
    expect(screen.getByText(/30 day shelf life/i)).toBeInTheDocument();
  });

  it('shows an empty-list message when no ingredients', () => {
    setup({ list: [] });
    render(<IngredientsPage />);
    expect(screen.getByText(/no ingredients yet/i)).toBeInTheDocument();
  });

  it('opens the Add dialog and submits a create call', async () => {
    const user = userEvent.setup();
    const { mutateAsyncCreate } = setup();
    render(<IngredientsPage />);

    await user.click(screen.getByRole('button', { name: /add ingredient/i }));
    await user.type(screen.getByLabelText('Name'), 'Garlic');
    await user.click(screen.getByRole('button', { name: /^add ingredient$/i }));

    await waitFor(() => {
      expect(mutateAsyncCreate).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Garlic' }),
      );
    });
  });

  it('surfaces INGREDIENT_NAME_TAKEN on the form during create', async () => {
    const user = userEvent.setup();
    const reject = vi
      .fn()
      .mockRejectedValue(makeTrpcError({ code: 'INGREDIENT_NAME_TAKEN' }));
    setup({ createMutation: reject });
    render(<IngredientsPage />);

    await user.click(screen.getByRole('button', { name: /add ingredient/i }));
    await user.type(screen.getByLabelText('Name'), 'Onion');
    await user.click(screen.getByRole('button', { name: /^add ingredient$/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/already exists/i);
    });
    expect(reject).toHaveBeenCalled();
  });

  it('opens the Edit dialog prefilled with the row', async () => {
    const user = userEvent.setup();
    setup();
    render(<IngredientsPage />);

    const onionRow = screen.getByTestId(`ingredient-row-${String(ONION.id)}`);
    await user.click(findButton(onionRow, 'Edit'));

    await waitFor(() => {
      expect(screen.getByLabelText('Name')).toHaveValue('Onion');
    });
  });

  it('confirms delete and calls the mutation', async () => {
    const user = userEvent.setup();
    const { mutateAsyncDelete } = setup();
    render(<IngredientsPage />);

    const onionRow = screen.getByTestId(`ingredient-row-${String(ONION.id)}`);
    const rowDelete = findButton(onionRow, 'Delete');
    await user.click(rowDelete);

    const confirmDelete = screen
      .getAllByRole('button', { name: 'Delete' })
      .find((b) => b !== rowDelete);
    if (!confirmDelete) throw new Error('confirm Delete button not found');
    await user.click(confirmDelete);

    await waitFor(() => {
      expect(mutateAsyncDelete).toHaveBeenCalledWith({ id: ONION.id });
    });
  });

  it('surfaces INGREDIENT_IN_USE in the delete dialog', async () => {
    const user = userEvent.setup();
    const reject = vi
      .fn()
      .mockRejectedValue(makeTrpcError({ code: 'INGREDIENT_IN_USE' }));
    setup({ deleteMutation: reject });
    render(<IngredientsPage />);

    const onionRow = screen.getByTestId(`ingredient-row-${String(ONION.id)}`);
    const rowDelete = findButton(onionRow, 'Delete');
    await user.click(rowDelete);

    const confirmDelete = screen
      .getAllByRole('button', { name: 'Delete' })
      .find((b) => b !== rowDelete);
    if (!confirmDelete) throw new Error('confirm Delete button not found');
    await user.click(confirmDelete);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        /used in one or more recipes/i,
      );
    });
  });

  it('debounces the search input before querying', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      setup();
      render(<IngredientsPage />);

      const search = screen.getByLabelText(/search ingredients/i);
      const typingUser = userEvent.setup({
        advanceTimers: (ms: number) => vi.advanceTimersByTime(ms),
      });
      await typingUser.type(search, 'oni');
      vi.advanceTimersByTime(250);

      await waitFor(() => {
        const calls = listUseQueryMock.mock.calls;
        const lastCall = calls[calls.length - 1];
        expect(lastCall?.[0]).toEqual({ search: 'oni' });
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
