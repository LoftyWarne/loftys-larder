import type {
  GetShoppingListForPlanResult,
  ShoppingListLine,
} from '@loftys-larder/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetOfflineQueueStoreForTests,
  createInMemoryQueueStore,
  type OfflineQueueStore,
} from '@/lib/offline-queue.ts';

const {
  listUseQueryMock,
  toggleMutateMock,
  drainMutateAsyncMock,
  getDataMock,
  setDataMock,
  cancelMock,
  invalidateMock,
  paramsMock,
  dismissMutateMock,
  reserveMutateAsyncMock,
  storageInvalidateMock,
} = vi.hoisted(() => ({
  dismissMutateMock: vi.fn(),
  reserveMutateAsyncMock: vi.fn().mockResolvedValue(undefined),
  storageInvalidateMock: vi.fn().mockResolvedValue(undefined),
  listUseQueryMock: vi.fn(),
  toggleMutateMock: vi.fn(),
  drainMutateAsyncMock: vi.fn().mockResolvedValue(undefined),
  getDataMock: vi.fn(),
  setDataMock: vi.fn(),
  cancelMock: vi.fn().mockResolvedValue(undefined),
  invalidateMock: vi.fn().mockResolvedValue(undefined),
  paramsMock: vi.fn(),
}));

let mutationOptions: Record<string, unknown> = {};

vi.mock('@tanstack/react-router', () => ({
  useParams: () => paramsMock() as unknown,
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    // The plan picker reads active + future plans; empty keeps it hidden
    // (needs ≥2 plans to render) so these tests stay focused on the list.
    plans: {
      list: { useQuery: () => ({ data: { items: [] } }) },
    },
    useUtils: () => ({
      shopping: {
        getForPlan: {
          cancel: cancelMock,
          getData: getDataMock,
          setData: setDataMock,
          invalidate: invalidateMock,
        },
      },
      storage: { list: { invalidate: storageInvalidateMock } },
    }),
    shopping: {
      getForPlan: { useQuery: listUseQueryMock },
      dismissStorageGlance: {
        useMutation: () => ({ mutate: dismissMutateMock, isPending: false }),
      },
      setLineReservations: {
        useMutation: () => ({
          mutateAsync: reserveMutateAsyncMock,
          isPending: false,
        }),
      },
      toggleChecked: {
        useMutation: (opts?: Record<string, unknown>) => {
          // The optimistic hook passes onMutate/onError/onSettled; the drain
          // mutation passes nothing. Discriminate so each test can address
          // the right one.
          if (opts && 'onMutate' in opts) {
            mutationOptions = opts;
            return { mutate: toggleMutateMock, isPending: false };
          }
          return {
            mutateAsync: drainMutateAsyncMock,
            mutate: vi.fn(),
            isPending: false,
          };
        },
      },
    },
  },
}));

import { ShoppingListPage } from './shopping-list-page.tsx';

const LIST: GetShoppingListForPlanResult = {
  planId: 9,
  staplesToRestock: [],
  staplesYouHave: [],
  showStorageGlance: false,
  categories: [
    {
      category: { id: 1, name: 'Produce' },
      lines: [
        {
          ingredient: { id: 100, name: 'Tomato' },
          unit: { id: 1, name: 'g' },
          totalQuantity: '500.000',
          reserved: '0.000',
          leftToBuy: '500.000',
          fromStorage: false,
          stockItems: [],
          contributingSlots: [
            {
              slotId: 1,
              recipeId: 10,
              recipeName: 'Tomato pasta',
              date: '2026-06-15',
              scaledQuantity: '500.000',
              isOptional: false,
            },
          ],
          isChecked: false,
          isOptional: false,
        },
      ],
    },
    {
      category: { id: 2, name: 'Pantry' },
      lines: [
        {
          ingredient: { id: 200, name: 'Pasta' },
          unit: { id: 1, name: 'g' },
          totalQuantity: '400.000',
          reserved: '0.000',
          leftToBuy: '400.000',
          fromStorage: false,
          stockItems: [],
          contributingSlots: [
            {
              slotId: 1,
              recipeId: 10,
              recipeName: 'Tomato pasta',
              date: '2026-06-15',
              scaledQuantity: '400.000',
              isOptional: false,
            },
          ],
          isChecked: true,
          isOptional: false,
        },
      ],
    },
  ],
};

interface SetupOptions {
  list?: GetShoppingListForPlanResult;
  isLoading?: boolean;
  error?: { message: string } | null;
  params?: Record<string, string>;
}

function setup(options: SetupOptions = {}): void {
  paramsMock.mockReturnValue(options.params ?? { planId: '9' });
  listUseQueryMock.mockReturnValue({
    data: options.list ?? LIST,
    isLoading: options.isLoading ?? false,
    error: options.error ?? null,
  });
}

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    get: () => value,
  });
}

let queueStore: OfflineQueueStore;

beforeEach(() => {
  listUseQueryMock.mockReset();
  toggleMutateMock.mockReset();
  drainMutateAsyncMock.mockReset();
  drainMutateAsyncMock.mockResolvedValue(undefined);
  getDataMock.mockReset();
  setDataMock.mockReset();
  cancelMock.mockClear();
  invalidateMock.mockClear();
  paramsMock.mockReset();
  dismissMutateMock.mockReset();
  reserveMutateAsyncMock.mockReset();
  reserveMutateAsyncMock.mockResolvedValue(undefined);
  mutationOptions = {};
  queueStore = createInMemoryQueueStore();
  __resetOfflineQueueStoreForTests(queueStore);
  setOnline(true);
});

afterEach(() => {
  __resetOfflineQueueStoreForTests(null);
  setOnline(true);
});

describe('ShoppingListPage', () => {
  it('renders the loading state while the query resolves', () => {
    setup({ list: undefined, isLoading: true });
    render(<ShoppingListPage />);
    expect(screen.getByRole('status')).toHaveTextContent(
      /loading shopping list/i,
    );
  });

  it('renders the error message when the query fails', () => {
    setup({ list: undefined, error: { message: 'boom' } });
    render(<ShoppingListPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
  });

  it('renders an empty-state message when the plan has no lines', () => {
    setup({
      list: {
        planId: 9,
        categories: [],
        staplesToRestock: [],
        staplesYouHave: [],
        showStorageGlance: false,
      },
    });
    render(<ShoppingListPage />);
    expect(screen.getByRole('status')).toHaveTextContent(/nothing to shop/i);
  });

  it('renders categories in server order with their lines', () => {
    setup();
    render(<ShoppingListPage />);

    const headers = screen.getAllByRole('heading', { level: 2 });
    expect(headers.map((h) => h.textContent)).toEqual(['Produce', 'Pantry']);
    expect(screen.getByText('Tomato')).toBeInTheDocument();
    expect(screen.getByText('Pasta')).toBeInTheDocument();
  });

  it('toggling a line calls the toggleChecked mutation with the right input', async () => {
    setup();
    render(<ShoppingListPage />);

    const checkbox = screen.getByRole('checkbox', {
      name: /mark Tomato as bought/i,
    });
    await userEvent.click(checkbox);
    expect(toggleMutateMock).toHaveBeenCalledWith({
      planId: 9,
      ingredientId: 100,
      isChecked: true,
    });
  });

  it('rejects an invalid plan id', () => {
    setup({ params: { planId: 'abc' } });
    render(<ShoppingListPage />);
    expect(screen.getByRole('alert')).toHaveTextContent(/invalid plan id/i);
  });

  it('renders an offline banner when navigator.onLine is false', async () => {
    setOnline(false);
    setup();
    render(<ShoppingListPage />);
    expect(
      screen.getByText(/offline — toggles will sync/i),
    ).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
    });
  });

  it('shows the "Pending sync" indicator on queued lines', async () => {
    await queueStore.enqueue({
      planId: 9,
      ingredientId: 100,
      isChecked: true,
    });
    setOnline(false);
    setup();
    render(<ShoppingListPage />);

    await waitFor(() => {
      expect(
        screen.getByRole('status', { name: /pending sync/i }),
      ).toBeInTheDocument();
    });
  });

  it('drains the queue on mount when online and invalidates the list on success', async () => {
    await queueStore.enqueue({
      planId: 9,
      ingredientId: 100,
      isChecked: true,
    });
    setup();
    render(<ShoppingListPage />);

    await waitFor(() => {
      expect(drainMutateAsyncMock).toHaveBeenCalledWith({
        planId: 9,
        ingredientId: 100,
        isChecked: true,
      });
    });
    await waitFor(() => {
      expect(invalidateMock).toHaveBeenCalledWith({ planId: 9 });
    });
    expect(await queueStore.list()).toEqual([]);
  });

  it('drains on reconnect when an online event fires', async () => {
    setOnline(false);
    setup();
    render(<ShoppingListPage />);

    await act(async () => {
      await queueStore.enqueue({
        planId: 9,
        ingredientId: 100,
        isChecked: true,
      });
    });

    expect(drainMutateAsyncMock).not.toHaveBeenCalled();

    setOnline(true);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(drainMutateAsyncMock).toHaveBeenCalledTimes(1);
    });
  });

  it('surfaces a mutation error at the top of the page when the hook calls onError', async () => {
    setup();
    render(<ShoppingListPage />);

    const onError = mutationOptions.onError as (
      err: unknown,
      vars: unknown,
      ctx: { previous: GetShoppingListForPlanResult | undefined } | undefined,
    ) => void;

    await act(async () => {
      onError(new Error('toggle failed'), undefined, { previous: undefined });
      await Promise.resolve();
    });

    expect(screen.getByRole('alert')).toHaveTextContent('toggle failed');
  });

  describe('shopping against storage', () => {
    const COD_LINE: ShoppingListLine = {
      ingredient: { id: 300, name: 'Cod' },
      unit: { id: 1, name: 'g' },
      totalQuantity: '400.000',
      contributingSlots: [
        {
          slotId: 5,
          recipeId: 50,
          recipeName: 'Fish Pie',
          date: '2026-06-16',
          scaledQuantity: '400.000',
          isOptional: false,
        },
      ],
      isChecked: false,
      isOptional: false,
      reserved: '0.000',
      leftToBuy: '400.000',
      fromStorage: false,
      stockItems: [
        {
          stockItemId: 70,
          location: 'freezer',
          available: '500.000',
          reservedByLine: '0.000',
          addedOn: '2026-05-01',
          useBy: null,
        },
      ],
    };

    function withCod(
      overrides: Partial<ShoppingListLine> = {},
      list: Partial<GetShoppingListForPlanResult> = {},
    ): GetShoppingListForPlanResult {
      return {
        planId: 9,
        categories: [
          {
            category: { id: 3, name: 'Fish' },
            lines: [{ ...COD_LINE, ...overrides }],
          },
        ],
        staplesToRestock: [],
        staplesYouHave: [],
        showStorageGlance: false,
        ...list,
      };
    }

    it('shows what is held, and uses it from the sheet', async () => {
      setup({ list: withCod() });
      const user = userEvent.setup();
      render(<ShoppingListPage />);

      await user.click(
        screen.getByRole('button', { name: /cod: in freezer: 500 g/i }),
      );
      const dialog = await screen.findByRole('dialog');
      await user.click(
        within(dialog).getByRole('button', {
          name: 'Use 400 g from storage',
        }),
      );
      await waitFor(() => {
        expect(reserveMutateAsyncMock).toHaveBeenCalledWith({
          planId: 9,
          ingredientId: 300,
          choice: { kind: 'all' },
        });
      });
    });

    it('buys anyway, or uses some and buys the rest', async () => {
      setup({ list: withCod() });
      const user = userEvent.setup();
      render(<ShoppingListPage />);

      await user.click(screen.getByRole('button', { name: /cod:/i }));
      let dialog = await screen.findByRole('dialog');
      await user.click(
        within(dialog).getByRole('button', { name: 'Buy anyway' }),
      );
      await waitFor(() => {
        expect(reserveMutateAsyncMock).toHaveBeenLastCalledWith(
          expect.objectContaining({ choice: { kind: 'none' } }),
        );
      });

      await user.click(screen.getByRole('button', { name: /cod:/i }));
      dialog = await screen.findByRole('dialog');
      await user.type(
        within(dialog).getByLabelText('Use some, buy the rest'),
        '150',
      );
      await user.click(within(dialog).getByRole('button', { name: 'Use' }));
      await waitFor(() => {
        expect(reserveMutateAsyncMock).toHaveBeenLastCalledWith(
          expect.objectContaining({
            choice: { kind: 'amount', amount: '150' },
          }),
        );
      });
    });

    it('lets the cook choose which items to draw from', async () => {
      setup({
        list: withCod({
          stockItems: [
            ...COD_LINE.stockItems,
            {
              stockItemId: 71,
              location: 'fridge',
              available: '100.000',
              reservedByLine: '0.000',
              addedOn: '2026-06-10',
              useBy: '2026-06-18',
            },
          ],
        }),
      });
      const user = userEvent.setup();
      render(<ShoppingListPage />);
      await user.click(screen.getByRole('button', { name: /cod:/i }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByText('Choose which items'));
      const freezer = within(dialog).getByLabelText(/in freezer/i);
      expect(freezer).toHaveValue('400');
      await user.clear(freezer);
      await user.type(freezer, '250');
      await user.click(
        within(dialog).getByRole('button', { name: 'Use these' }),
      );
      await waitFor(() => {
        expect(reserveMutateAsyncMock).toHaveBeenLastCalledWith(
          expect.objectContaining({
            choice: {
              kind: 'draws',
              draws: [{ stockItemId: 70, amount: '250' }],
            },
          }),
        );
      });
    });

    it('shows what is left to buy, and a covered line as From storage with no tick', () => {
      setup({
        list: {
          ...withCod({
            reserved: '150.000',
            leftToBuy: '250.000',
          }),
        },
      });
      const { unmount } = render(<ShoppingListPage />);
      expect(screen.getByText('250 g to buy')).toBeInTheDocument();
      expect(screen.getByText('(150 g from storage)')).toBeInTheDocument();
      unmount();

      setup({
        list: withCod({
          reserved: '400.000',
          leftToBuy: '0.000',
          fromStorage: true,
        }),
      });
      render(<ShoppingListPage />);
      expect(screen.getByText('From storage')).toBeInTheDocument();
      expect(
        screen.queryByRole('checkbox', { name: /cod/i }),
      ).not.toBeInTheDocument();
    });

    it('turns reserving off while offline', () => {
      setOnline(false);
      setup({ list: withCod() });
      render(<ShoppingListPage />);
      expect(screen.getByRole('button', { name: /cod:/i })).toBeDisabled();
    });

    it('shows the glance until dismissed', async () => {
      setup({ list: withCod({}, { showStorageGlance: true }) });
      const user = userEvent.setup();
      render(<ShoppingListPage />);
      const banner = screen.getByRole('complementary', {
        name: 'Check your Staples and storage',
      });
      await user.click(within(banner).getByRole('button', { name: 'Dismiss' }));
      expect(dismissMutateMock).toHaveBeenCalledWith(
        { planId: 9 },
        expect.anything(),
      );
      expect(setDataMock).toHaveBeenCalled();
    });

    it('lists Staples to restock, ticked like any line, and the Staples you have folded away', async () => {
      setup({
        list: withCod(
          {},
          {
            staplesToRestock: [
              {
                ingredient: { id: 400, name: 'Olive Oil' },
                unit: { id: 2, name: 'ml' },
                location: 'pantry',
                state: 'running_low',
                neededQuantity: null,
                contributingSlots: [],
                isChecked: false,
              },
            ],
            staplesYouHave: [
              {
                ingredient: { id: 401, name: 'Butter' },
                unit: { id: 1, name: 'g' },
                location: 'fridge',
                state: 'in_stock',
                neededQuantity: '20.000',
                contributingSlots: [],
                isChecked: false,
              },
            ],
          },
        ),
      });
      const user = userEvent.setup();
      render(<ShoppingListPage />);

      const restock = screen
        .getByRole('heading', { name: 'Staples to restock' })
        .closest('section');
      expect(restock).toHaveTextContent('Olive Oil');
      expect(restock).toHaveTextContent('Pantry');
      expect(restock).toHaveTextContent('Running low');
      await user.click(
        screen.getByRole('checkbox', { name: 'Mark Olive Oil as bought' }),
      );
      expect(toggleMutateMock).toHaveBeenCalledWith({
        planId: 9,
        ingredientId: 400,
        isChecked: true,
      });

      expect(screen.getByText('Staples you have (1)')).toBeInTheDocument();
      expect(screen.getByText('Butter')).not.toBeVisible();
    });
  });
});
