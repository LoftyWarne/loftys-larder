import type { GetShoppingListForPlanResult } from '@loftys-larder/shared';
import { act, render, screen, waitFor } from '@testing-library/react';
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
} = vi.hoisted(() => ({
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
}));

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    useUtils: () => ({
      shopping: {
        getForPlan: {
          cancel: cancelMock,
          getData: getDataMock,
          setData: setDataMock,
          invalidate: invalidateMock,
        },
      },
    }),
    shopping: {
      getForPlan: { useQuery: listUseQueryMock },
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
  categories: [
    {
      category: { id: 1, name: 'Produce' },
      lines: [
        {
          ingredient: { id: 100, name: 'Tomato' },
          unit: { id: 1, name: 'g' },
          totalQuantity: '500.000',
          contributingSlots: [
            {
              slotId: 1,
              recipeId: 10,
              recipeName: 'Tomato pasta',
              date: '2026-06-15',
              scaledQuantity: '500.000',
            },
          ],
          isChecked: false,
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
          contributingSlots: [
            {
              slotId: 1,
              recipeId: 10,
              recipeName: 'Tomato pasta',
              date: '2026-06-15',
              scaledQuantity: '400.000',
            },
          ],
          isChecked: true,
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
    setup({ list: { planId: 9, categories: [] } });
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
});
