import type { GetShoppingListForPlanResult } from '@loftys-larder/shared';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  listUseQueryMock,
  toggleMutateMock,
  getDataMock,
  setDataMock,
  cancelMock,
  paramsMock,
} = vi.hoisted(() => ({
  listUseQueryMock: vi.fn(),
  toggleMutateMock: vi.fn(),
  getDataMock: vi.fn(),
  setDataMock: vi.fn(),
  cancelMock: vi.fn().mockResolvedValue(undefined),
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
        },
      },
    }),
    shopping: {
      getForPlan: { useQuery: listUseQueryMock },
      toggleChecked: {
        useMutation: (opts: Record<string, unknown>) => {
          mutationOptions = opts;
          return { mutate: toggleMutateMock, isPending: false };
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

beforeEach(() => {
  listUseQueryMock.mockReset();
  toggleMutateMock.mockReset();
  getDataMock.mockReset();
  setDataMock.mockReset();
  cancelMock.mockClear();
  paramsMock.mockReset();
  mutationOptions = {};
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

  it('surfaces a mutation error at the top of the page when the hook calls onError', () => {
    setup();
    render(<ShoppingListPage />);

    const onError = mutationOptions.onError as (
      err: unknown,
      vars: unknown,
      ctx: { previous: GetShoppingListForPlanResult | undefined } | undefined,
    ) => void;

    act(() => {
      onError(new Error('toggle failed'), undefined, { previous: undefined });
    });

    expect(screen.getByRole('alert')).toHaveTextContent('toggle failed');
  });
});
