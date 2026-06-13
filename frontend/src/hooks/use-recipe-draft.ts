import type {
  RecipeDraftEnvelope,
  UpsertRecipeDraftInput,
} from '@loftys-larder/shared';
import { RECIPE_DRAFT_VERSION } from '@loftys-larder/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { trpc } from '@/lib/trpc.ts';

// Server-side autosave for the recipe editor. Loads any existing draft on
// mount (per-recipe for existing recipes, most-recent NULL row for new ones),
// merges draft fields over server defaults, and writes back debounced (~1s)
// trailing-edge. First call after a quiet period waits the full debounce
// (no leading-edge fire) so a single keystroke doesn't trigger a round-trip.
// On unmount, the pending upsert is cancelled.

const AUTOSAVE_DEBOUNCE_MS = 1000;

export interface UseRecipeDraftOptions<S extends object> {
  recipeId: number | null;
  enabled: boolean;
  serverDefaults: S;
  debounceMs?: number;
}

export interface UseRecipeDraftResult<S extends object> {
  isReady: boolean;
  mergedDefaults: S;
  draftPresent: boolean;
  savedAt: number | null;
  queueAutosave: (sectionKey: keyof S & string, values: unknown) => void;
  clearSection: (sectionKey: keyof S & string) => void;
  discardDraft: () => void;
}

export function useRecipeDraft<S extends object>(
  options: UseRecipeDraftOptions<S>,
): UseRecipeDraftResult<S> {
  const { recipeId, enabled, serverDefaults } = options;
  const debounceMs = options.debounceMs ?? AUTOSAVE_DEBOUNCE_MS;

  const utils = trpc.useUtils();

  const forRecipeQuery = trpc.recipeDrafts.getForRecipe.useQuery(
    { recipeId: recipeId ?? 0 },
    { enabled: enabled && recipeId !== null, retry: false },
  );
  const newDraftsQuery = trpc.recipeDrafts.getNewDrafts.useQuery(undefined, {
    enabled: enabled && recipeId === null,
    retry: false,
  });

  const upsertMutation = trpc.recipeDrafts.upsert.useMutation();
  const deleteMutation = trpc.recipeDrafts.delete.useMutation();

  const loadedDraft = useMemo(() => {
    if (recipeId === null) {
      return newDraftsQuery.data?.[0] ?? null;
    }
    return forRecipeQuery.data ?? null;
  }, [recipeId, newDraftsQuery.data, forRecipeQuery.data]);

  const isReady =
    recipeId === null ? newDraftsQuery.isSuccess : forRecipeQuery.isSuccess;

  // The draft row id we are currently attached to. For existing-recipe drafts
  // the upsert uses ON CONFLICT (user_id, recipe_id) so the id is determined
  // server-side; for new-recipe drafts we capture it on the first insert and
  // pass it back on subsequent upserts so a single row survives many writes.
  const attachedDraftIdRef = useRef<number | null>(null);
  const fieldsRef = useRef<Record<string, unknown>>({});
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recipeIdRef = useRef<number | null>(recipeId);
  recipeIdRef.current = recipeId;

  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [draftClearedLocally, setDraftClearedLocally] = useState(false);

  // Seed fields and attached id from the loaded draft.
  useEffect(() => {
    if (loadedDraft) {
      attachedDraftIdRef.current = loadedDraft.id;
      fieldsRef.current = { ...loadedDraft.draftData.fields };
      setSavedAt(loadedDraft.lastUpdatedAt);
      setDraftClearedLocally(false);
    } else {
      attachedDraftIdRef.current = null;
      fieldsRef.current = {};
      setSavedAt(null);
    }
  }, [loadedDraft]);

  const mergedDefaults = useMemo<S>(() => {
    if (!loadedDraft || draftClearedLocally) return serverDefaults;
    const fields = loadedDraft.draftData.fields;
    const out = { ...serverDefaults } as Record<string, unknown>;
    for (const key of Object.keys(fields)) {
      out[key] = fields[key];
    }
    return out as S;
  }, [loadedDraft, draftClearedLocally, serverDefaults]);

  const draftPresent = loadedDraft !== null && !draftClearedLocally;

  const cancelPending = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  const invalidateDraftQueries = useCallback(async (): Promise<void> => {
    const currentRecipeId = recipeIdRef.current;
    if (currentRecipeId === null) {
      await utils.recipeDrafts.getNewDrafts.invalidate();
    } else {
      await utils.recipeDrafts.getForRecipe.invalidate({
        recipeId: currentRecipeId,
      });
    }
  }, [utils.recipeDrafts]);

  const flushUpsert = useCallback(() => {
    const fields = fieldsRef.current;
    const envelope: RecipeDraftEnvelope = {
      version: RECIPE_DRAFT_VERSION,
      fields: { ...fields },
    };
    const input: UpsertRecipeDraftInput = {
      recipeId: recipeIdRef.current,
      draftData: envelope,
    };
    const attachedId = attachedDraftIdRef.current;
    if (attachedId !== null) input.draftId = attachedId;
    upsertMutation.mutate(input, {
      onSuccess: (result) => {
        attachedDraftIdRef.current = result.id;
        setSavedAt(result.lastUpdatedAt);
        setDraftClearedLocally(false);
      },
    });
  }, [upsertMutation]);

  const queueAutosave = useCallback(
    (sectionKey: keyof S & string, values: unknown) => {
      fieldsRef.current = { ...fieldsRef.current, [sectionKey]: values };
      cancelPending();
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        flushUpsert();
      }, debounceMs);
    },
    [cancelPending, flushUpsert, debounceMs],
  );

  const clearSection = useCallback(
    (sectionKey: keyof S & string) => {
      const next: Record<string, unknown> = {};
      for (const key of Object.keys(fieldsRef.current)) {
        if (key === sectionKey) continue;
        next[key] = fieldsRef.current[key];
      }
      fieldsRef.current = next;
      cancelPending();
      if (Object.keys(next).length === 0) {
        const attachedId = attachedDraftIdRef.current;
        if (attachedId === null) {
          setDraftClearedLocally(true);
          return;
        }
        deleteMutation.mutate(
          { recipeId: recipeIdRef.current },
          {
            onSuccess: () => {
              attachedDraftIdRef.current = null;
              setDraftClearedLocally(true);
              setSavedAt(null);
              void invalidateDraftQueries();
            },
          },
        );
        return;
      }
      // Still-dirty sections remain — write through immediately so the
      // section just saved doesn't leak back into the merge on reload.
      flushUpsert();
    },
    [cancelPending, deleteMutation, flushUpsert, invalidateDraftQueries],
  );

  const discardDraft = useCallback(() => {
    cancelPending();
    fieldsRef.current = {};
    deleteMutation.mutate(
      { recipeId: recipeIdRef.current },
      {
        onSuccess: () => {
          attachedDraftIdRef.current = null;
          setDraftClearedLocally(true);
          setSavedAt(null);
          void invalidateDraftQueries();
        },
      },
    );
  }, [cancelPending, deleteMutation, invalidateDraftQueries]);

  useEffect(() => {
    return () => {
      cancelPending();
    };
  }, [cancelPending]);

  return {
    isReady,
    mergedDefaults,
    draftPresent,
    savedAt,
    queueAutosave,
    clearSection,
    discardDraft,
  };
}
