import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getForRecipeUseQueryMock,
  getNewDraftsUseQueryMock,
  upsertUseMutationMock,
  deleteUseMutationMock,
  upsertMutateMock,
  deleteMutateMock,
  getForRecipeInvalidateMock,
  getNewDraftsInvalidateMock,
} = vi.hoisted(() => ({
  getForRecipeUseQueryMock: vi.fn(),
  getNewDraftsUseQueryMock: vi.fn(),
  upsertUseMutationMock: vi.fn(),
  deleteUseMutationMock: vi.fn(),
  upsertMutateMock: vi.fn(),
  deleteMutateMock: vi.fn(),
  getForRecipeInvalidateMock: vi.fn(),
  getNewDraftsInvalidateMock: vi.fn(),
}));

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    useUtils: () => ({
      recipeDrafts: {
        getForRecipe: { invalidate: getForRecipeInvalidateMock },
        getNewDrafts: { invalidate: getNewDraftsInvalidateMock },
      },
    }),
    recipeDrafts: {
      getForRecipe: { useQuery: getForRecipeUseQueryMock },
      getNewDrafts: { useQuery: getNewDraftsUseQueryMock },
      upsert: { useMutation: upsertUseMutationMock },
      delete: { useMutation: deleteUseMutationMock },
    },
  },
}));

import { useRecipeDraft } from './use-recipe-draft.ts';

const SERVER_DEFAULTS = {
  header: { name: 'Server name', description: null },
  method: [{ id: 1, stepNumber: 1, instruction: 'Server step' }],
} as const;

type Defaults = typeof SERVER_DEFAULTS;

beforeEach(() => {
  vi.clearAllMocks();
  getForRecipeUseQueryMock.mockReturnValue({
    data: null,
    isSuccess: true,
    error: null,
  });
  getNewDraftsUseQueryMock.mockReturnValue({
    data: [],
    isSuccess: true,
    error: null,
  });
  upsertUseMutationMock.mockReturnValue({ mutate: upsertMutateMock });
  deleteUseMutationMock.mockReturnValue({ mutate: deleteMutateMock });
  getForRecipeInvalidateMock.mockResolvedValue(undefined);
  getNewDraftsInvalidateMock.mockResolvedValue(undefined);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useRecipeDraft', () => {
  it('returns server defaults when no draft exists', () => {
    const { result } = renderHook(() =>
      useRecipeDraft<Defaults>({
        recipeId: 7,
        enabled: true,
        serverDefaults: SERVER_DEFAULTS,
      }),
    );

    expect(result.current.mergedDefaults).toEqual(SERVER_DEFAULTS);
    expect(result.current.draftPresent).toBe(false);
  });

  it('overlays draft fields over server defaults when a draft exists', () => {
    getForRecipeUseQueryMock.mockReturnValue({
      data: {
        id: 99,
        draftData: {
          version: 1,
          fields: { header: { name: 'Draft name', description: 'draft desc' } },
        },
        lastUpdatedAt: 1700000000000,
      },
      isSuccess: true,
      error: null,
    });

    const { result } = renderHook(() =>
      useRecipeDraft<Defaults>({
        recipeId: 7,
        enabled: true,
        serverDefaults: SERVER_DEFAULTS,
      }),
    );

    expect(result.current.draftPresent).toBe(true);
    expect(result.current.mergedDefaults.header).toEqual({
      name: 'Draft name',
      description: 'draft desc',
    });
    // Unmentioned sections fall through from the server.
    expect(result.current.mergedDefaults.method).toEqual(
      SERVER_DEFAULTS.method,
    );
  });

  it('collapses a burst of keystrokes into one debounced upsert', () => {
    const { result } = renderHook(() =>
      useRecipeDraft<Defaults>({
        recipeId: 7,
        enabled: true,
        serverDefaults: SERVER_DEFAULTS,
        debounceMs: 1000,
      }),
    );

    act(() => {
      result.current.queueAutosave('header', { name: 'A' });
      vi.advanceTimersByTime(100);
      result.current.queueAutosave('header', { name: 'AB' });
      vi.advanceTimersByTime(100);
      result.current.queueAutosave('header', { name: 'ABC' });
    });

    expect(upsertMutateMock).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(upsertMutateMock).toHaveBeenCalledTimes(1);
    const payload = upsertMutateMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      recipeId: 7,
      draftData: {
        version: 1,
        fields: { header: { name: 'ABC' } },
      },
    });
  });

  it('does not fire on the first keystroke before the debounce elapses', () => {
    const { result } = renderHook(() =>
      useRecipeDraft<Defaults>({
        recipeId: 7,
        enabled: true,
        serverDefaults: SERVER_DEFAULTS,
        debounceMs: 1000,
      }),
    );

    act(() => {
      result.current.queueAutosave('header', { name: 'A' });
    });

    // 999 ms after the call, still nothing.
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(upsertMutateMock).not.toHaveBeenCalled();
  });

  it('cancels the pending autosave on unmount', () => {
    const { result, unmount } = renderHook(() =>
      useRecipeDraft<Defaults>({
        recipeId: 7,
        enabled: true,
        serverDefaults: SERVER_DEFAULTS,
        debounceMs: 1000,
      }),
    );

    act(() => {
      result.current.queueAutosave('header', { name: 'Pending' });
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(upsertMutateMock).not.toHaveBeenCalled();
  });

  it('passes draftId on subsequent upserts so a new-recipe row survives', () => {
    let onSuccess:
      | ((result: { id: number; lastUpdatedAt: number }) => void)
      | undefined;
    upsertMutateMock.mockImplementation(
      (
        _input: unknown,
        opts: {
          onSuccess?: (r: { id: number; lastUpdatedAt: number }) => void;
        },
      ) => {
        onSuccess = opts.onSuccess;
      },
    );

    const { result } = renderHook(() =>
      useRecipeDraft<Defaults>({
        recipeId: null,
        enabled: true,
        serverDefaults: SERVER_DEFAULTS,
        debounceMs: 1000,
      }),
    );

    act(() => {
      result.current.queueAutosave('header', { name: 'First' });
      vi.advanceTimersByTime(1000);
    });

    expect(upsertMutateMock).toHaveBeenCalledTimes(1);
    expect(upsertMutateMock.mock.calls[0]?.[0]).toMatchObject({
      recipeId: null,
    });
    expect(upsertMutateMock.mock.calls[0]?.[0]).not.toHaveProperty('draftId');

    act(() => {
      onSuccess?.({ id: 42, lastUpdatedAt: 1 });
    });

    act(() => {
      result.current.queueAutosave('header', { name: 'Second' });
      vi.advanceTimersByTime(1000);
    });

    expect(upsertMutateMock).toHaveBeenCalledTimes(2);
    expect(upsertMutateMock.mock.calls[1]?.[0]).toMatchObject({
      draftId: 42,
      recipeId: null,
    });
  });

  it('clearSection removes that key and writes through immediately when others remain', () => {
    const { result } = renderHook(() =>
      useRecipeDraft<Defaults>({
        recipeId: 7,
        enabled: true,
        serverDefaults: SERVER_DEFAULTS,
        debounceMs: 1000,
      }),
    );

    act(() => {
      result.current.queueAutosave('header', { name: 'H' });
      result.current.queueAutosave('method', [{ instruction: 'X' }]);
      vi.advanceTimersByTime(1000);
    });
    expect(upsertMutateMock).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.clearSection('header');
    });

    // Immediate write of the remaining fields, no debounce wait.
    expect(upsertMutateMock).toHaveBeenCalledTimes(2);
    const second = upsertMutateMock.mock.calls[1]?.[0] as {
      draftData: { fields: Record<string, unknown> };
    };
    expect(second.draftData.fields).toEqual({
      method: [{ instruction: 'X' }],
    });
    expect(deleteMutateMock).not.toHaveBeenCalled();
  });

  it('clearSection deletes the row when no sections remain', () => {
    let upsertSuccess:
      | ((r: { id: number; lastUpdatedAt: number }) => void)
      | undefined;
    upsertMutateMock.mockImplementation(
      (
        _input: unknown,
        opts: {
          onSuccess?: (r: { id: number; lastUpdatedAt: number }) => void;
        },
      ) => {
        upsertSuccess = opts.onSuccess;
      },
    );
    let deleteSuccess: (() => void) | undefined;
    deleteMutateMock.mockImplementation(
      (_input: unknown, opts: { onSuccess?: () => void }) => {
        deleteSuccess = opts.onSuccess;
      },
    );

    const { result } = renderHook(() =>
      useRecipeDraft<Defaults>({
        recipeId: 7,
        enabled: true,
        serverDefaults: SERVER_DEFAULTS,
        debounceMs: 1000,
      }),
    );

    act(() => {
      result.current.queueAutosave('header', { name: 'H' });
      vi.advanceTimersByTime(1000);
    });
    // Pretend the server confirmed and gave us an attached id.
    act(() => {
      upsertSuccess?.({ id: 99, lastUpdatedAt: 1 });
    });

    act(() => {
      result.current.clearSection('header');
    });

    expect(deleteMutateMock).toHaveBeenCalledTimes(1);
    expect(deleteMutateMock.mock.calls[0]?.[0]).toEqual({ recipeId: 7 });

    act(() => {
      deleteSuccess?.();
    });
    expect(getForRecipeInvalidateMock).toHaveBeenCalledWith({ recipeId: 7 });
  });

  it('discardDraft deletes the row and invalidates queries', () => {
    let deleteSuccess: (() => void) | undefined;
    deleteMutateMock.mockImplementation(
      (_input: unknown, opts: { onSuccess?: () => void }) => {
        deleteSuccess = opts.onSuccess;
      },
    );

    getForRecipeUseQueryMock.mockReturnValue({
      data: {
        id: 99,
        draftData: { version: 1, fields: { header: { name: 'D' } } },
        lastUpdatedAt: 1,
      },
      isSuccess: true,
      error: null,
    });

    const { result } = renderHook(() =>
      useRecipeDraft<Defaults>({
        recipeId: 7,
        enabled: true,
        serverDefaults: SERVER_DEFAULTS,
        debounceMs: 1000,
      }),
    );

    expect(result.current.draftPresent).toBe(true);

    act(() => {
      result.current.discardDraft();
    });

    expect(deleteMutateMock).toHaveBeenCalledWith(
      { recipeId: 7 },
      expect.any(Object),
    );

    act(() => {
      deleteSuccess?.();
    });

    expect(result.current.draftPresent).toBe(false);
    expect(getForRecipeInvalidateMock).toHaveBeenCalledWith({ recipeId: 7 });
  });
});
