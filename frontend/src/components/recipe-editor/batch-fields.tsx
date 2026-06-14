import { useEffect, useState } from 'react';

import {
  SearchableCombobox,
  type SearchableComboboxOption,
} from '@/components/searchable-combobox.tsx';
import { Button } from '@/components/ui/button.tsx';

// Edit-mode batch-cooking surface (DEC-23). `isBase` lives here rather than
// on `header-fields` so the diff/patch surface of the header stays unchanged
// (session notes 2026-06-13). The base picker is hidden when `isBase` is
// true — a recipe cannot be both a base and a batch-version (XOR enforced
// by the procedure + DB CHECK).

export type RecipePickerOption = SearchableComboboxOption;

export interface BatchFieldsValues {
  isBase: boolean;
  baseRecipeId: number | null;
  pairedRecipeId: number | null;
}

interface BatchFieldsPartner {
  id: number;
  name: string;
  isDeleted: boolean;
}

export interface BatchFieldsProps {
  initial: BatchFieldsValues;
  baseRecipePartner: BatchFieldsPartner | null;
  pairedRecipePartner: BatchFieldsPartner | null;
  searchBases: (
    query: string,
  ) => Promise<readonly RecipePickerOption[]> | readonly RecipePickerOption[];
  searchPairs: (
    query: string,
  ) => Promise<readonly RecipePickerOption[]> | readonly RecipePickerOption[];
  onSubmit: (changes: Partial<BatchFieldsValues>) => Promise<void>;
  savedNoticeKey?: number;
  errorMessage?: string | null;
}

export function BatchFields({
  initial,
  baseRecipePartner,
  pairedRecipePartner,
  searchBases,
  searchPairs,
  onSubmit,
  savedNoticeKey,
  errorMessage,
}: BatchFieldsProps): React.ReactElement {
  const [isBase, setIsBase] = useState(initial.isBase);
  const [base, setBase] = useState<RecipePickerOption | null>(
    baseRecipePartner && !baseRecipePartner.isDeleted
      ? { id: baseRecipePartner.id, label: baseRecipePartner.name }
      : null,
  );
  const [pair, setPair] = useState<RecipePickerOption | null>(
    pairedRecipePartner && !pairedRecipePartner.isDeleted
      ? { id: pairedRecipePartner.id, label: pairedRecipePartner.name }
      : null,
  );
  const [submitting, setSubmitting] = useState(false);

  // Re-seed on the recipe id changing (route swap) — the parent passes a new
  // `initial` shape when the route's recipeId changes, so reset local state.
  useEffect(() => {
    setIsBase(initial.isBase);
  }, [initial.isBase]);
  useEffect(() => {
    setBase(
      baseRecipePartner && !baseRecipePartner.isDeleted
        ? { id: baseRecipePartner.id, label: baseRecipePartner.name }
        : null,
    );
  }, [baseRecipePartner]);
  useEffect(() => {
    setPair(
      pairedRecipePartner && !pairedRecipePartner.isDeleted
        ? { id: pairedRecipePartner.id, label: pairedRecipePartner.name }
        : null,
    );
  }, [pairedRecipePartner]);

  async function handleSubmit(
    event: React.SyntheticEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    const baseRecipeId = isBase ? null : (base?.id ?? null);
    const pairedRecipeId = pair?.id ?? null;
    const changes: Partial<BatchFieldsValues> = {};
    if (isBase !== initial.isBase) changes.isBase = isBase;
    if (baseRecipeId !== initial.baseRecipeId) {
      changes.baseRecipeId = baseRecipeId;
    }
    if (pairedRecipeId !== initial.pairedRecipeId) {
      changes.pairedRecipeId = pairedRecipeId;
    }
    if (Object.keys(changes).length === 0) return;
    setSubmitting(true);
    try {
      await onSubmit(changes);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
      className="space-y-4"
      aria-labelledby="recipe-batch-heading"
    >
      <h2 id="recipe-batch-heading" className="text-lg font-semibold">
        Batch cooking
      </h2>

      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          disabled={submitting}
          checked={isBase}
          onChange={(event) => {
            const next = event.target.checked;
            setIsBase(next);
            // A base is a component, not a meal — it doesn't have a
            // full↔batch sibling (DEC-23). Clear any selected pair so the
            // save round-trip clears both sides via the symmetry transaction.
            if (next) {
              setBase(null);
              setPair(null);
            }
          }}
        />
        <span>This is a base recipe (batch-cookable)</span>
      </label>

      {!isBase && (
        <div className="space-y-1">
          <label htmlFor="recipe-base" className="text-sm font-medium">
            Base recipe
          </label>
          {baseRecipePartner?.isDeleted && (
            <p className="text-sm text-muted-foreground">
              {baseRecipePartner.name} (deleted)
            </p>
          )}
          <SearchableCombobox
            id="recipe-base"
            ariaLabel="Search base recipes"
            value={base}
            onChange={setBase}
            searchQuery={searchBases}
            placeholder="Search bases…"
            emptyMessage="No bases match"
            disabled={submitting}
          />
        </div>
      )}

      {!isBase && (
        <div className="space-y-1">
          <label htmlFor="recipe-pair" className="text-sm font-medium">
            Paired recipe
          </label>
          {pairedRecipePartner?.isDeleted && (
            <p className="text-sm text-muted-foreground">
              {pairedRecipePartner.name} (deleted)
            </p>
          )}
          <SearchableCombobox
            id="recipe-pair"
            ariaLabel="Search paired recipes"
            value={pair}
            onChange={setPair}
            searchQuery={searchPairs}
            placeholder="Search recipes…"
            emptyMessage="No matches"
            disabled={submitting}
          />
        </div>
      )}

      {errorMessage && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage}
        </p>
      )}

      <SavedNotice key={savedNoticeKey} show={savedNoticeKey !== undefined} />

      <div className="flex justify-end">
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Save batch fields'}
        </Button>
      </div>
    </form>
  );
}

function SavedNotice({ show }: { show: boolean }): React.ReactElement | null {
  if (!show) return null;
  return (
    <p role="status" className="text-sm text-emerald-600">
      Saved.
    </p>
  );
}
