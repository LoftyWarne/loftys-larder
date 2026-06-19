import type { ListPlansResult, PlanListItem } from '@loftys-larder/shared';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TRPCClientError } from '@trpc/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  listUseQueryMock,
  createMutateAsyncMock,
  duplicateMutateAsyncMock,
  deleteMutateAsyncMock,
  searchMock,
  navigateMock,
  invalidateMock,
  cancelMock,
  getDataMock,
  setDataMock,
} = vi.hoisted(() => ({
  listUseQueryMock: vi.fn(),
  createMutateAsyncMock: vi.fn(),
  duplicateMutateAsyncMock: vi.fn(),
  deleteMutateAsyncMock: vi.fn(),
  searchMock: vi.fn(),
  navigateMock: vi.fn().mockResolvedValue(undefined),
  invalidateMock: vi.fn().mockResolvedValue(undefined),
  cancelMock: vi.fn().mockResolvedValue(undefined),
  getDataMock: vi.fn(),
  setDataMock: vi.fn(),
}));

let deleteMutationOptions: Record<string, unknown> = {};

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => searchMock() as unknown,
  useNavigate: () => navigateMock,
  Link: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props}>{props.children}</a>
  ),
}));

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    useUtils: () => ({
      plans: {
        list: {
          invalidate: invalidateMock,
          cancel: cancelMock,
          getData: getDataMock,
          setData: setDataMock,
        },
      },
    }),
    plans: {
      list: { useQuery: listUseQueryMock },
      create: {
        useMutation: () => ({
          mutateAsync: createMutateAsyncMock,
          isPending: false,
        }),
      },
      duplicate: {
        useMutation: () => ({
          mutateAsync: duplicateMutateAsyncMock,
          isPending: false,
        }),
      },
      delete: {
        useMutation: (opts: Record<string, unknown>) => {
          deleteMutationOptions = opts;
          return {
            mutateAsync: deleteMutateAsyncMock,
            isPending: false,
          };
        },
      },
    },
  },
}));

import { PlansPage } from './plans-page.tsx';

const ACTIVE_PLAN: PlanListItem = {
  id: 1,
  startDate: '2026-06-15',
  endDate: '2026-06-21',
  createdByUserId: 'user-1',
  slotsTotal: 14,
  slotsAssigned: 12,
};

const FUTURE_PLAN: PlanListItem = {
  id: 2,
  startDate: '2026-07-01',
  endDate: '2026-07-07',
  createdByUserId: 'user-1',
  slotsTotal: 14,
  slotsAssigned: 0,
};

interface SetupOptions {
  items?: PlanListItem[];
  search?: { status?: 'active' | 'past' | 'future' | 'all' };
  isLoading?: boolean;
  error?: { message: string } | null;
}

function setup(options: SetupOptions = {}): void {
  searchMock.mockReturnValue(options.search ?? { status: 'active' });
  listUseQueryMock.mockReturnValue({
    data: { items: options.items ?? [ACTIVE_PLAN] } satisfies ListPlansResult,
    isLoading: options.isLoading ?? false,
    error: options.error ?? null,
  });
}

beforeEach(() => {
  listUseQueryMock.mockReset();
  createMutateAsyncMock.mockReset();
  duplicateMutateAsyncMock.mockReset();
  deleteMutateAsyncMock.mockReset();
  searchMock.mockReset();
  navigateMock.mockReset().mockResolvedValue(undefined);
  invalidateMock.mockReset().mockResolvedValue(undefined);
  cancelMock.mockReset().mockResolvedValue(undefined);
  getDataMock.mockReset();
  setDataMock.mockReset();
  deleteMutationOptions = {};
});

describe('PlansPage', () => {
  it('renders the active filter as selected by default and lists plans', () => {
    setup();
    render(<PlansPage />);

    expect(
      screen.getByRole('radio', { name: 'Active', checked: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Mon 15th – Sun 21st Jun 2026'),
    ).toBeInTheDocument();
    expect(screen.getByText('12/14 slots assigned')).toBeInTheDocument();
  });

  it('switching to past navigates with the new status search param', async () => {
    const user = userEvent.setup();
    setup();
    render(<PlansPage />);

    await user.click(screen.getByRole('radio', { name: 'Past' }));
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/plans',
      search: { status: 'past' },
    });
  });

  it('renders the per-filter empty state', () => {
    setup({ items: [], search: { status: 'future' } });
    render(<PlansPage />);

    expect(screen.getByText(/no future plans scheduled/i)).toBeInTheDocument();
  });

  it('new-plan dialog navigates to the new plan on success', async () => {
    const user = userEvent.setup();
    setup();
    createMutateAsyncMock.mockResolvedValueOnce({
      plan: { id: 99, startDate: '2026-06-22', endDate: '2026-06-28' },
      slotCount: 14,
    });
    render(<PlansPage />);

    await user.click(screen.getByRole('button', { name: /new plan/i }));
    await user.click(screen.getByRole('button', { name: /create plan/i }));

    expect(createMutateAsyncMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/plans/$planId',
      params: { planId: '99' },
    });
  });

  it('new-plan dialog surfaces PLAN_DATE_OVERLAP and stays open', async () => {
    const user = userEvent.setup();
    setup();
    const overlapError = new TRPCClientError('overlap', {
      result: {
        error: {
          message: 'overlap',
          code: -32_009,
          data: {
            code: 'CONFLICT',
            cause: {
              code: 'PLAN_DATE_OVERLAP',
              conflictingPlanIds: [1],
            },
          },
        },
      },
    });
    createMutateAsyncMock.mockRejectedValueOnce(overlapError);
    render(<PlansPage />);

    await user.click(screen.getByRole('button', { name: /new plan/i }));
    await user.click(screen.getByRole('button', { name: /create plan/i }));

    expect(
      screen.getByText(/overlaps an existing active or future plan/i),
    ).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('duplicate dialog forwards a new start date and navigates on success', async () => {
    const user = userEvent.setup();
    setup();
    duplicateMutateAsyncMock.mockResolvedValueOnce({
      plan: { id: 77, startDate: '2026-07-08', endDate: '2026-07-14' },
      slotCount: 14,
    });
    render(<PlansPage />);

    const duplicateButtons = screen.getAllByRole('button', {
      name: /duplicate/i,
    });
    const firstDuplicate = duplicateButtons[0];
    if (!firstDuplicate) throw new Error('duplicate button missing');
    await user.click(firstDuplicate);
    const input = screen.getByLabelText(/new start date/i);
    await user.clear(input);
    await user.type(input, '2026-07-08');
    await user.click(screen.getByRole('button', { name: /^duplicate$/i }));

    expect(duplicateMutateAsyncMock).toHaveBeenCalledWith({
      planId: 1,
      newStartDate: '2026-07-08',
    });
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/plans/$planId',
      params: { planId: '77' },
    });
  });

  it('delete confirm calls plans.delete; optimistic onMutate strips the row and onError restores it', async () => {
    const user = userEvent.setup();
    setup({ items: [ACTIVE_PLAN, FUTURE_PLAN] });
    deleteMutateAsyncMock.mockResolvedValueOnce({ id: 1 });
    render(<PlansPage />);

    const deleteButtons = screen.getAllByRole('button', { name: /delete/i });
    const firstDelete = deleteButtons[0];
    if (!firstDelete) throw new Error('delete button missing');
    await user.click(firstDelete);
    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    expect(deleteMutateAsyncMock).toHaveBeenCalledWith({ id: 1 });

    // Optimistic cache: onMutate filters the targeted plan id out.
    const onMutate = deleteMutationOptions.onMutate as (vars: {
      id: number;
    }) => Promise<{ previous: ListPlansResult | undefined }>;
    getDataMock.mockReturnValueOnce({
      items: [ACTIVE_PLAN, FUTURE_PLAN],
    });
    await act(async () => {
      await onMutate({ id: 1 });
    });
    expect(setDataMock).toHaveBeenCalledWith(
      { status: 'active' },
      { items: [FUTURE_PLAN] },
    );

    // Rollback: onError puts the snapshot back.
    const onError = deleteMutationOptions.onError as (
      err: unknown,
      vars: unknown,
      ctx: { previous: ListPlansResult | undefined } | undefined,
    ) => void;
    const snapshot: ListPlansResult = { items: [ACTIVE_PLAN, FUTURE_PLAN] };
    act(() => {
      onError(new Error('boom'), { id: 1 }, { previous: snapshot });
    });
    expect(setDataMock).toHaveBeenLastCalledWith(
      { status: 'active' },
      snapshot,
    );
  });
});
