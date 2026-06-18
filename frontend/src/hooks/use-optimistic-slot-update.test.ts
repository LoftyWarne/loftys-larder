import type {
  GetPlanResult,
  PlanSlot,
  PlanSlotPairedRecipe,
  PlanSlotRecipe,
  UpdateSlotInput,
} from '@loftys-larder/shared';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateMutateMock, getDataMock, setDataMock, cancelMock } = vi.hoisted(
  () => ({
    updateMutateMock: vi.fn(),
    getDataMock: vi.fn(),
    setDataMock: vi.fn(),
    cancelMock: vi.fn().mockResolvedValue(undefined),
  }),
);

let mutationOptions: Record<string, unknown> = {};

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    useUtils: () => ({
      plans: {
        get: {
          cancel: cancelMock,
          getData: getDataMock,
          setData: setDataMock,
        },
      },
    }),
    slots: {
      update: {
        useMutation: (opts: Record<string, unknown>) => {
          mutationOptions = opts;
          return { mutate: updateMutateMock, isPending: false };
        },
      },
    },
  },
}));

import { useOptimisticSlotUpdate } from './use-optimistic-slot-update.ts';

const SLOT_EMPTY: PlanSlot = {
  id: 5,
  planId: 9,
  date: '2026-06-15',
  occasionId: 2,
  occasionName: 'Dinner',
  slotType: 'empty',
  recipeId: null,
  numberOfServings: null,
  chefUserId: null,
  cooksBaseRecipeId: null,
  cooksBaseServings: null,
  comment: null,
  recipe: null,
  cooksBaseRecipe: null,
  pairedRecipe: null,
};

const PLAN: GetPlanResult = {
  id: 9,
  startDate: '2026-06-15',
  endDate: '2026-06-15',
  createdByUserId: 'user-1',
  slots: [SLOT_EMPTY],
};

const RECIPE_PREVIEW: PlanSlotRecipe = {
  id: 10,
  name: 'Tomato pasta',
  imageUrl: null,
  isBase: false,
  baseRecipeId: null,
  pairedRecipeId: null,
  isDeleted: false,
};

const ASSIGN_INPUT: UpdateSlotInput = {
  slotId: 5,
  slotType: 'recipe',
  recipeId: 10,
  numberOfServings: 2,
  chefUserId: null,
  cooksBaseRecipeId: null,
  cooksBaseServings: null,
  comment: null,
};

beforeEach(() => {
  updateMutateMock.mockReset();
  getDataMock.mockReset();
  setDataMock.mockReset();
  cancelMock.mockClear();
  mutationOptions = {};
});

describe('useOptimisticSlotUpdate', () => {
  it('forwards the input to the slots.update mutation', () => {
    const { result } = renderHook(() => useOptimisticSlotUpdate({ planId: 9 }));
    result.current.update({
      input: ASSIGN_INPUT,
      optimisticRecipe: RECIPE_PREVIEW,
    });
    expect(updateMutateMock).toHaveBeenCalledWith(ASSIGN_INPUT);
  });

  it('applies an optimistic patch with the provided preview recipe', async () => {
    getDataMock.mockReturnValue(PLAN);
    renderHook(() => useOptimisticSlotUpdate({ planId: 9 }));

    // The hook's `update` consumes the preview via a ref — simulate the call
    // sequence: `update(...)` stages the preview, then `onMutate` reads it.
    const { result } = renderHook(() => useOptimisticSlotUpdate({ planId: 9 }));
    const onMutate = mutationOptions.onMutate as (
      input: UpdateSlotInput,
    ) => Promise<{ previous: GetPlanResult | undefined }>;
    result.current.update({
      input: ASSIGN_INPUT,
      optimisticRecipe: RECIPE_PREVIEW,
    });
    await onMutate(ASSIGN_INPUT);

    expect(setDataMock).toHaveBeenCalledTimes(1);
    const call = setDataMock.mock.calls[0];
    if (!call) throw new Error('expected setData call');
    expect(call[0]).toEqual({ id: 9 });
    const patched = call[1] as GetPlanResult;
    const slot = patched.slots[0];
    expect(slot).toMatchObject({
      slotType: 'recipe',
      recipeId: 10,
      numberOfServings: 2,
      recipe: RECIPE_PREVIEW,
    });
  });

  it('rolls back the cache on error', async () => {
    getDataMock.mockReturnValue(PLAN);
    renderHook(() => useOptimisticSlotUpdate({ planId: 9 }));

    const onMutate = mutationOptions.onMutate as (
      input: UpdateSlotInput,
    ) => Promise<{ previous: GetPlanResult | undefined }>;
    const onError = mutationOptions.onError as (
      err: unknown,
      vars: unknown,
      ctx: { previous: GetPlanResult | undefined } | undefined,
    ) => void;

    const ctx = await onMutate(ASSIGN_INPUT);
    setDataMock.mockClear();
    onError(new Error('boom'), ASSIGN_INPUT, ctx);
    expect(setDataMock).toHaveBeenCalledWith({ id: 9 }, PLAN);
  });

  it('reconciles the cache with the server-returned slot on settle', () => {
    getDataMock.mockReturnValue(PLAN);
    renderHook(() => useOptimisticSlotUpdate({ planId: 9 }));

    const onSettled = mutationOptions.onSettled as (
      data: { slot: PlanSlot } | undefined,
    ) => void;

    const serverSlot: PlanSlot = {
      ...SLOT_EMPTY,
      slotType: 'recipe',
      recipeId: 10,
      numberOfServings: 3,
      recipe: { ...RECIPE_PREVIEW, name: 'Tomato pasta (canonical)' },
    };
    onSettled({ slot: serverSlot });

    expect(setDataMock).toHaveBeenCalledTimes(1);
    const call = setDataMock.mock.calls[0];
    if (!call) throw new Error('expected setData call');
    const reconciled = call[1] as GetPlanResult;
    expect(reconciled.slots[0]).toEqual(serverSlot);
  });

  it('writes the optimistic paired recipe into the patched slot', async () => {
    getDataMock.mockReturnValue(PLAN);
    const { result } = renderHook(() => useOptimisticSlotUpdate({ planId: 9 }));
    const onMutate = mutationOptions.onMutate as (
      input: UpdateSlotInput,
    ) => Promise<{ previous: GetPlanResult | undefined }>;
    const paired: PlanSlotPairedRecipe = {
      id: 11,
      name: 'Sibling',
      imageUrl: null,
      isBase: false,
      baseRecipeId: null,
      baseServings: 2,
      isDeleted: false,
    };
    result.current.update({
      input: ASSIGN_INPUT,
      optimisticRecipe: RECIPE_PREVIEW,
      optimisticPairedRecipe: paired,
    });
    await onMutate(ASSIGN_INPUT);

    const call = setDataMock.mock.calls[0];
    if (!call) throw new Error('expected setData call');
    const patched = call[1] as GetPlanResult;
    expect(patched.slots[0]?.pairedRecipe).toEqual(paired);
  });

  it('invokes the caller onError when the mutation fails', () => {
    const onErrorSpy = vi.fn();
    renderHook(() =>
      useOptimisticSlotUpdate({ planId: 9, onError: onErrorSpy }),
    );

    const onError = mutationOptions.onError as (
      err: unknown,
      vars: unknown,
      ctx: { previous: GetPlanResult | undefined } | undefined,
    ) => void;
    const err = new Error('boom');
    onError(err, ASSIGN_INPUT, { previous: undefined });
    expect(onErrorSpy).toHaveBeenCalledWith(err);
  });
});
