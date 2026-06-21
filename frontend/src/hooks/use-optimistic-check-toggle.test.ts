import type {
  GetShoppingListForPlanResult,
  ToggleShoppingItemCheckedInput,
  ToggleShoppingItemCheckedResult,
} from '@loftys-larder/shared';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createInMemoryQueueStore } from '@/lib/offline-queue.ts';

const { toggleMutateMock, getDataMock, setDataMock, cancelMock } = vi.hoisted(
  () => ({
    toggleMutateMock: vi.fn(),
    getDataMock: vi.fn(),
    setDataMock: vi.fn(),
    cancelMock: vi.fn().mockResolvedValue(undefined),
  }),
);

let mutationOptions: Record<string, unknown> = {};

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
      toggleChecked: {
        useMutation: (opts: Record<string, unknown>) => {
          mutationOptions = opts;
          return { mutate: toggleMutateMock, isPending: false };
        },
      },
    },
  },
}));

import { useOptimisticCheckToggle } from './use-optimistic-check-toggle.ts';

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
          contributingSlots: [],
          isChecked: false,
        },
        {
          ingredient: { id: 101, name: 'Onion' },
          unit: { id: 1, name: 'g' },
          totalQuantity: '300.000',
          contributingSlots: [],
          isChecked: false,
        },
      ],
    },
  ],
};

const INPUT: ToggleShoppingItemCheckedInput = {
  planId: 9,
  ingredientId: 100,
  isChecked: true,
};

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    get: () => value,
  });
}

beforeEach(() => {
  toggleMutateMock.mockReset();
  getDataMock.mockReset();
  setDataMock.mockReset();
  cancelMock.mockClear();
  mutationOptions = {};
  setOnline(true);
});

afterEach(() => {
  setOnline(true);
});

describe('useOptimisticCheckToggle', () => {
  it('forwards the input to the mutation', () => {
    const { result } = renderHook(() =>
      useOptimisticCheckToggle({ planId: 9 }),
    );
    result.current.toggle(INPUT);
    expect(toggleMutateMock).toHaveBeenCalledWith(INPUT);
  });

  it('cancels in-flight queries and patches the matching line optimistically', async () => {
    getDataMock.mockReturnValue(LIST);
    renderHook(() => useOptimisticCheckToggle({ planId: 9 }));

    const onMutate = mutationOptions.onMutate as (
      input: ToggleShoppingItemCheckedInput,
    ) => Promise<{ previous: GetShoppingListForPlanResult | undefined }>;
    await onMutate(INPUT);

    expect(cancelMock).toHaveBeenCalledWith({ planId: 9 });
    expect(setDataMock).toHaveBeenCalledTimes(1);
    const call = setDataMock.mock.calls[0];
    if (!call) throw new Error('expected setData call');
    expect(call[0]).toEqual({ planId: 9 });
    const patched = call[1] as GetShoppingListForPlanResult;
    const lines = patched.categories[0]?.lines ?? [];
    expect(lines[0]?.isChecked).toBe(true);
    expect(lines[1]?.isChecked).toBe(false);
  });

  it('rolls back the cache on error', async () => {
    getDataMock.mockReturnValue(LIST);
    renderHook(() => useOptimisticCheckToggle({ planId: 9 }));

    const onMutate = mutationOptions.onMutate as (
      input: ToggleShoppingItemCheckedInput,
    ) => Promise<{ previous: GetShoppingListForPlanResult | undefined }>;
    const onError = mutationOptions.onError as (
      err: unknown,
      vars: unknown,
      ctx: { previous: GetShoppingListForPlanResult | undefined } | undefined,
    ) => void;

    const ctx = await onMutate(INPUT);
    setDataMock.mockClear();
    onError(new Error('boom'), INPUT, ctx);
    expect(setDataMock).toHaveBeenCalledWith({ planId: 9 }, LIST);
  });

  it('invokes the caller onError when the mutation fails', () => {
    const onErrorSpy = vi.fn();
    renderHook(() =>
      useOptimisticCheckToggle({ planId: 9, onError: onErrorSpy }),
    );

    const onError = mutationOptions.onError as (
      err: unknown,
      vars: unknown,
      ctx: { previous: GetShoppingListForPlanResult | undefined } | undefined,
    ) => void;
    const err = new Error('boom');
    onError(err, INPUT, { previous: undefined });
    expect(onErrorSpy).toHaveBeenCalledWith(err);
  });

  it('when offline, keeps the optimistic patch, enqueues, and suppresses onError', async () => {
    setOnline(false);
    getDataMock.mockReturnValue(LIST);
    const store = createInMemoryQueueStore();
    const onErrorSpy = vi.fn();
    renderHook(() =>
      useOptimisticCheckToggle({
        planId: 9,
        onError: onErrorSpy,
        offlineQueueStore: store,
      }),
    );

    const onMutate = mutationOptions.onMutate as (
      input: ToggleShoppingItemCheckedInput,
    ) => Promise<{ previous: GetShoppingListForPlanResult | undefined }>;
    const onError = mutationOptions.onError as (
      err: unknown,
      vars: ToggleShoppingItemCheckedInput,
      ctx: { previous: GetShoppingListForPlanResult | undefined } | undefined,
    ) => void;

    const ctx = await onMutate(INPUT);
    setDataMock.mockClear();
    onError(new TypeError('Failed to fetch'), INPUT, ctx);

    expect(setDataMock).not.toHaveBeenCalled();
    expect(onErrorSpy).not.toHaveBeenCalled();
    await vi.waitFor(async () => {
      const entries = await store.list();
      expect(entries).toEqual([
        expect.objectContaining({
          planId: 9,
          ingredientId: 100,
          isChecked: true,
        }),
      ]);
    });
  });

  it('successful mutation removes a matching queued entry', async () => {
    const store = createInMemoryQueueStore();
    await store.enqueue({
      planId: 9,
      ingredientId: 100,
      isChecked: false,
    });
    renderHook(() =>
      useOptimisticCheckToggle({ planId: 9, offlineQueueStore: store }),
    );

    const onSuccess = mutationOptions.onSuccess as (
      data: unknown,
      vars: ToggleShoppingItemCheckedInput,
    ) => void;
    onSuccess(
      { planId: 9, ingredientId: 100, isChecked: true },
      { planId: 9, ingredientId: 100, isChecked: true },
    );

    await vi.waitFor(async () => {
      expect(await store.list()).toEqual([]);
    });
  });

  it('reconciles the cache with the server-returned isChecked on settle', () => {
    getDataMock.mockReturnValue(LIST);
    renderHook(() => useOptimisticCheckToggle({ planId: 9 }));

    const onSettled = mutationOptions.onSettled as (
      data: ToggleShoppingItemCheckedResult | undefined,
    ) => void;

    onSettled({ planId: 9, ingredientId: 100, isChecked: true });

    expect(setDataMock).toHaveBeenCalledTimes(1);
    const call = setDataMock.mock.calls[0];
    if (!call) throw new Error('expected setData call');
    const reconciled = call[1] as GetShoppingListForPlanResult;
    expect(reconciled.categories[0]?.lines[0]?.isChecked).toBe(true);
  });
});
