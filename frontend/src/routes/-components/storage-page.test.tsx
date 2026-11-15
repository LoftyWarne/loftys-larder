import type {
  StockItem,
  StorageLocation,
  StorageStaple,
} from '@loftys-larder/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TRPCClientError } from '@trpc/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  listUseQueryMock,
  createUseMutationMock,
  updateUseMutationMock,
  deleteUseMutationMock,
  ingredientsCreateMock,
  referencesUseQueryMock,
  useUtilsMock,
  searchMock,
  ingredientsUpdateMock,
  setStapleStateMock,
} = vi.hoisted(() => ({
  ingredientsUpdateMock: vi.fn(),
  setStapleStateMock: vi.fn(),
  listUseQueryMock: vi.fn(),
  createUseMutationMock: vi.fn(),
  updateUseMutationMock: vi.fn(),
  deleteUseMutationMock: vi.fn(),
  ingredientsCreateMock: vi.fn(),
  referencesUseQueryMock: vi.fn(),
  useUtilsMock: vi.fn(),
  searchMock: vi.fn<() => { location: StorageLocation }>(),
}));

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    storage: {
      list: { useQuery: listUseQueryMock },
      create: { useMutation: createUseMutationMock },
      update: { useMutation: updateUseMutationMock },
      delete: { useMutation: deleteUseMutationMock },
    },
    ingredients: {
      create: { useMutation: ingredientsCreateMock },
      references: { useQuery: referencesUseQueryMock },
      update: { useMutation: ingredientsUpdateMock },
      setStapleState: { useMutation: setStapleStateMock },
    },
    useUtils: useUtilsMock,
  },
}));

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => searchMock(),
  Link: ({
    to,
    params,
    search,
    children,
    className,
    ...rest
  }: {
    to: string;
    params?: Record<string, string>;
    search?: Record<string, string>;
    children: React.ReactNode;
    className?: string;
  }) => {
    let href = to;
    for (const [key, value] of Object.entries(params ?? {})) {
      href = href.replace(`$${key}`, value);
    }
    const query = new URLSearchParams(search ?? {}).toString();
    return (
      <a
        href={query ? `${href}?${query}` : href}
        className={className}
        {...rest}
      >
        {children}
      </a>
    );
  },
}));

import { StoragePage } from './storage-page.tsx';

const TODAY = '2026-11-15';

const COD = {
  kind: 'ingredient' as const,
  ingredientId: 1,
  name: 'Cod',
  unitName: 'g',
  averageShelfLifeDays: null,
};
const CHICKEN = {
  kind: 'ingredient' as const,
  ingredientId: 2,
  name: 'Chicken Thigh',
  unitName: 'g',
  averageShelfLifeDays: 2,
};
const STEW = {
  kind: 'recipe' as const,
  recipeId: 9,
  name: 'Beef Stew Base',
  isBase: true,
  isDeleted: false,
};
const OLD_CURRY = {
  kind: 'recipe' as const,
  recipeId: 10,
  name: 'Old Curry',
  isBase: false,
  isDeleted: true,
};

function stock(id: number, overrides: Partial<StockItem>): StockItem {
  return {
    id,
    location: 'freezer',
    target: COD,
    quantity: '500.000',
    reserved: '0.000',
    addedOn: TODAY,
    useBy: null,
    ...overrides,
  };
}

const ITEMS: StockItem[] = [
  stock(1, { target: COD, quantity: '300.000', addedOn: '2026-10-04' }),
  stock(2, { target: COD, quantity: '500.000', addedOn: '2026-11-08' }),
  stock(3, { target: STEW, quantity: '2.000', reserved: '1.000' }),
  stock(4, { target: OLD_CURRY, quantity: '1.000' }),
  stock(5, {
    target: CHICKEN,
    location: 'fridge',
    quantity: '200.000',
    useBy: '2026-11-14',
  }),
  stock(6, {
    target: CHICKEN,
    location: 'fridge',
    quantity: '100.000',
    useBy: '2026-11-19',
  }),
];

function makeTrpcError(cause: Record<string, unknown>): TRPCClientError<never> {
  const err = new TRPCClientError<never>('boom');
  Object.assign(err, { shape: { data: { cause } } });
  return err;
}

const STAPLES: StorageStaple[] = [
  {
    ingredientId: 20,
    name: 'Olive Oil',
    location: 'pantry',
    state: 'in_stock',
  },
  { ingredientId: 21, name: 'Rice', location: 'pantry', state: 'running_low' },
  { ingredientId: 22, name: 'Peas', location: 'freezer', state: 'out' },
];

const ingredientUpdate = vi.fn();
const setStapleState = vi.fn();
const ingredientsFetch = vi.fn();

function setup(
  location: StorageLocation = 'freezer',
  update = vi
    .fn()
    .mockResolvedValue({ id: 1, deleted: false, releasedReservations: 0 }),
): { update: ReturnType<typeof vi.fn>; invalidate: ReturnType<typeof vi.fn> } {
  searchMock.mockReturnValue({ location });
  listUseQueryMock.mockReturnValue({
    data: { today: TODAY, items: ITEMS, staples: STAPLES },
    isLoading: false,
    error: null,
  });
  const invalidate = vi.fn().mockResolvedValue(undefined);
  useUtilsMock.mockReturnValue({
    storage: { list: { invalidate } },
    shopping: { getForPlan: { invalidate: vi.fn() } },
    ingredients: { list: { invalidate: vi.fn(), fetch: ingredientsFetch } },
    recipes: { list: { fetch: vi.fn() } },
  });
  createUseMutationMock.mockReturnValue({ mutateAsync: vi.fn() });
  updateUseMutationMock.mockReturnValue({
    mutateAsync: update,
    isPending: false,
  });
  deleteUseMutationMock.mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue({ id: 1, releasedReservations: 0 }),
    isPending: false,
  });
  ingredientsCreateMock.mockReturnValue({ mutateAsync: vi.fn() });
  referencesUseQueryMock.mockReturnValue({ data: undefined });
  ingredientsUpdateMock.mockReturnValue({
    mutateAsync: ingredientUpdate,
    isPending: false,
  });
  setStapleStateMock.mockReturnValue({ mutate: setStapleState });
  return { update, invalidate };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('StoragePage', () => {
  it('has a tab per location, with the current one marked', () => {
    setup('freezer');
    render(<StoragePage />);
    const tabs = screen.getByRole('navigation', { name: 'Storage locations' });
    const links = within(tabs).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      'Freezer(3)',
      'Fridge(2)',
      'Pantry(0)',
    ]);
    expect(links[0]).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Ingredients' })).toHaveAttribute(
      'href',
      '/ingredients',
    );
  });

  it('combines Freezer items into one row, aged from the oldest, with dishes apart', async () => {
    setup('freezer');
    const user = userEvent.setup();
    render(<StoragePage />);

    const ingredients = screen.getByRole('region', { name: 'Ingredients' });
    expect(within(ingredients).getByText('Cod')).toBeInTheDocument();
    expect(within(ingredients).getByText('800 g')).toBeInTheDocument();
    expect(
      within(ingredients).getByText('frozen 6 weeks ago'),
    ).toBeInTheDocument();

    const dishes = screen.getByRole('region', { name: 'Dishes' });
    expect(
      within(dishes).getByRole('link', { name: 'Beef Stew Base' }),
    ).toHaveAttribute('href', '/recipes/9');
    expect(within(dishes).getByText('Base')).toBeInTheDocument();
    expect(
      within(dishes).getByText('2 portions, 1 reserved'),
    ).toBeInTheDocument();
    expect(within(dishes).getByText('(deleted)')).toBeInTheDocument();
    expect(
      within(dishes).queryByRole('link', { name: /old curry/i }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'Show each Cod item' }),
    );
    expect(within(ingredients).getByText('300 g')).toBeInTheDocument();
    expect(within(ingredients).getByText('500 g')).toBeInTheDocument();
  });

  it('lists Fridge items one by one, soonest Use-by first, marking a past one', () => {
    setup('fridge');
    render(<StoragePage />);
    const rows = within(
      screen.getByRole('region', { name: 'Ingredients' }),
    ).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('200 g');
    expect(rows[0]).toHaveTextContent('past use-by');
    expect(rows[1]).toHaveTextContent('100 g');
    expect(rows[1]).toHaveTextContent('use by Thu');
  });

  it('changes an amount in one tap, on the newest item', async () => {
    const { update, invalidate } = setup('freezer');
    const user = userEvent.setup();
    render(<StoragePage />);
    await user.click(
      screen.getByRole('button', { name: 'Less Beef Stew Base' }),
    );
    await waitFor(() => {
      expect(update).toHaveBeenCalledWith({
        id: 3,
        patch: { quantity: '1.000' },
        releaseReservations: undefined,
      });
    });
    expect(invalidate).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'More Cod' }));
    await waitFor(() => {
      expect(update).toHaveBeenLastCalledWith({
        id: 2,
        patch: { quantity: '550.000' },
        releaseReservations: undefined,
      });
    });
  });

  it('keeps the stepper off until the list has refetched', async () => {
    const { update, invalidate } = setup('freezer');
    let refetched!: () => void;
    invalidate.mockReturnValue(
      new Promise<void>((resolve) => {
        refetched = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<StoragePage />);
    const less = screen.getByRole('button', { name: 'Less Cod' });
    await user.click(less);
    await waitFor(() => {
      expect(update).toHaveBeenCalledTimes(1);
    });
    expect(less).toBeDisabled();

    refetched();
    await waitFor(() => {
      expect(less).toBeEnabled();
    });
  });

  it('asks before lowering below what’s reserved, then releases', async () => {
    const update = vi
      .fn()
      .mockRejectedValueOnce(
        makeTrpcError({
          code: 'STOCK_RESERVED',
          quantity: '0.000',
          reserved: '1.000',
        }),
      )
      .mockResolvedValue({ id: 3, deleted: true, releasedReservations: 1 });
    setup('freezer', update);
    const user = userEvent.setup();
    render(<StoragePage />);

    await user.click(
      screen.getByRole('button', { name: 'Less Beef Stew Base' }),
    );
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/set aside for a plan/i);
    await user.click(within(dialog).getByRole('button', { name: 'Lower it' }));
    await waitFor(() => {
      expect(update).toHaveBeenLastCalledWith(
        expect.objectContaining({ releaseReservations: true }),
      );
    });
  });

  it('opens a Fridge item’s sheet, clears Use-by when moved out', async () => {
    const { update } = setup('fridge');
    const user = userEvent.setup();
    render(<StoragePage />);
    const [, laterUseBy] = screen.getAllByRole('button', {
      name: 'Edit Chicken Thigh',
    });
    if (!laterUseBy) throw new Error('second Fridge row missing');
    await user.click(laterUseBy);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Use by')).toHaveValue('2026-11-19');
    await user.selectOptions(within(dialog).getByLabelText('Where'), 'freezer');
    expect(within(dialog).queryByLabelText('Use by')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(update).toHaveBeenCalledWith({
        id: 6,
        patch: {
          location: 'freezer',
          quantity: '100',
          addedOn: TODAY,
          useBy: null,
        },
        releaseReservations: undefined,
      });
    });
  });

  it('sets a fresh default Use-by from today when moved into the Fridge', async () => {
    searchMock.mockReturnValue({ location: 'freezer' });
    setup('freezer');
    listUseQueryMock.mockReturnValue({
      data: {
        today: TODAY,
        items: [stock(7, { target: CHICKEN, addedOn: '2026-10-01' })],
      },
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();
    render(<StoragePage />);
    await user.click(
      screen.getByRole('button', { name: 'Edit Chicken Thigh' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('Where'), 'fridge');
    expect(within(dialog).getByLabelText('Use by')).toHaveValue('2026-11-17');
  });

  it('adds a Fridge ingredient with its default Use-by', async () => {
    setup('fridge');
    const create = vi.fn().mockResolvedValue({ id: 99 });
    createUseMutationMock.mockReturnValue({ mutateAsync: create });
    const fetchIngredients = vi.fn().mockResolvedValue([
      {
        id: 2,
        name: 'Chicken Thigh',
        categoryId: 1,
        categoryName: 'Meat',
        defaultUnitId: 1,
        defaultUnitName: 'g',
        isPlant: false,
        averageShelfLifeDays: 2,
        stapleState: null,
        stapleLocation: null,
      },
    ]);
    const invalidate = vi.fn().mockResolvedValue(undefined);
    useUtilsMock.mockReturnValue({
      storage: { list: { invalidate } },
      ingredients: { list: { invalidate: vi.fn(), fetch: fetchIngredients } },
      recipes: { list: { fetch: vi.fn() } },
    });
    const user = userEvent.setup();
    render(<StoragePage />);

    await user.click(screen.getByRole('button', { name: 'Add' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Ingredient'), 'chick');
    await user.click(
      await screen.findByRole('option', { name: /chicken thigh/i }),
    );
    expect(within(dialog).getByText('g')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Use by')).toHaveValue('2026-11-17');
    await user.type(within(dialog).getByLabelText('Amount'), '200');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith({
        location: 'fridge',
        target: { kind: 'ingredient', ingredientId: 2 },
        quantity: '200',
        addedOn: TODAY,
        useBy: '2026-11-17',
      });
    });
    expect(invalidate).toHaveBeenCalled();
  });

  it('won’t add without picking something', async () => {
    setup('pantry');
    const create = vi.fn();
    createUseMutationMock.mockReturnValue({ mutateAsync: create });
    const user = userEvent.setup();
    render(<StoragePage />);
    await user.click(screen.getByRole('button', { name: 'Add' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Amount'), '2');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(
      await within(dialog).findByText('Pick an ingredient or dish'),
    ).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  describe('Staples', () => {
    it('lists the tab’s Staples, each with a one-tap state', async () => {
      setup('pantry');
      const user = userEvent.setup();
      render(<StoragePage />);

      const section = screen.getByRole('region', { name: 'Staples' });
      expect(within(section).getByText('Olive Oil')).toBeInTheDocument();
      expect(within(section).getByText('Rice')).toBeInTheDocument();
      expect(within(section).queryByText('Peas')).not.toBeInTheDocument();

      const rice = within(section).getByRole('radiogroup', {
        name: 'Rice: how much you have',
      });
      expect(
        within(rice).getByRole('radio', { name: 'Running low' }),
      ).toHaveAttribute('aria-checked', 'true');

      await user.click(
        within(
          within(section).getByRole('radiogroup', {
            name: 'Olive Oil: how much you have',
          }),
        ).getByRole('radio', { name: 'Out' }),
      );
      expect(setStapleState).toHaveBeenCalledWith(
        { id: 20, state: 'out' },
        expect.anything(),
      );
    });

    it('makes a picked ingredient a Staple here, asking first if it is held', async () => {
      setup('freezer');
      ingredientsFetch.mockResolvedValue([
        {
          id: 1,
          name: 'Cod',
          categoryId: 1,
          categoryName: 'Fish',
          defaultUnitId: 1,
          defaultUnitName: 'g',
          isPlant: false,
          averageShelfLifeDays: null,
          stapleState: null,
          stapleLocation: null,
        },
      ]);
      ingredientUpdate
        .mockRejectedValueOnce(
          makeTrpcError({
            code: 'INGREDIENT_STAPLE_HAS_STOCK',
            stockItems: 2,
            reservations: 1,
          }),
        )
        .mockResolvedValueOnce({});
      const user = userEvent.setup();
      render(<StoragePage />);

      await user.type(
        screen.getByLabelText('Add a Staple to the freezer'),
        'cod',
      );
      await user.click(await screen.findByRole('option', { name: /cod/i }));

      const dialog = await screen.findByRole('alertdialog');
      expect(dialog).toHaveTextContent('held in storage as 2 items');
      expect(dialog).toHaveTextContent('will be freed');
      await user.click(
        within(dialog).getByRole('button', { name: 'Make it a Staple' }),
      );
      await waitFor(() => {
        expect(ingredientUpdate).toHaveBeenLastCalledWith({
          id: 1,
          patch: { stapleLocation: 'freezer' },
          deleteStock: true,
        });
      });
    });

    it('won’t add a Staple as stock, and says where its state is kept', async () => {
      setup('pantry');
      useUtilsMock.mockReturnValue({
        storage: { list: { invalidate: vi.fn() } },
        shopping: { getForPlan: { invalidate: vi.fn() } },
        ingredients: {
          list: {
            invalidate: vi.fn(),
            fetch: vi.fn().mockResolvedValue([
              {
                id: 20,
                name: 'Olive Oil',
                categoryId: 1,
                categoryName: 'Oils',
                defaultUnitId: 1,
                defaultUnitName: 'ml',
                isPlant: false,
                averageShelfLifeDays: null,
                stapleState: 'in_stock',
                stapleLocation: 'pantry',
              },
            ]),
          },
        },
        recipes: { list: { fetch: vi.fn() } },
      });
      const user = userEvent.setup();
      render(<StoragePage />);
      await user.click(screen.getByRole('button', { name: 'Add' }));
      const dialog = await screen.findByRole('dialog');
      await user.type(within(dialog).getByLabelText('Ingredient'), 'oil');
      await user.click(
        await screen.findByRole('option', { name: /olive oil/i }),
      );
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        'Olive Oil is a Staple',
      );
      expect(within(dialog).getByRole('alert')).toHaveTextContent('Pantry tab');
    });
  });
});
