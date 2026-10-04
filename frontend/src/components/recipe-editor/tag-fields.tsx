import {
  normaliseRecipeTagName,
  RECIPE_TAG_NAME_MAX_LENGTH,
  RECIPE_TAGS_MAX,
} from '@loftys-larder/shared';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';

import type { RecipeSectionHandle } from '@/components/recipe-editor/section-handle.ts';
import {
  SearchableCombobox,
  type SearchableComboboxHandle,
  type SearchableComboboxOption,
} from '@/components/searchable-combobox.tsx';
import { Button } from '@/components/ui/button.tsx';

// Tags section of the recipe editor (DEC-97). Tags are held by name: picking
// an existing tag or typing a new one both add a chip, and saving sends the
// names for the server to match or create. There is no rename / delete here.

export interface TagFieldsProps {
  initialNames: readonly string[];
  initialDraftNames?: readonly string[];
  searchTags: (
    query: string,
  ) =>
    | Promise<readonly SearchableComboboxOption[]>
    | readonly SearchableComboboxOption[];
  onSubmit: (names: string[]) => Promise<boolean>;
  onNamesChange?: (names: string[]) => void;
  savedNoticeKey?: number;
  hideSaveButton?: boolean;
}

export const TagFields = forwardRef<RecipeSectionHandle, TagFieldsProps>(
  function TagFields(
    {
      initialNames,
      initialDraftNames,
      searchTags,
      onSubmit,
      onNamesChange,
      savedNoticeKey,
      hideSaveButton = false,
    },
    ref,
  ): React.ReactElement {
    const [names, setNames] = useState<string[]>(() => [
      ...(initialDraftNames ?? initialNames),
    ]);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Bumped on every add so the combobox remounts with an empty input; the
    // fresh input takes focus so several tags can be typed in a row.
    const [pickerKey, setPickerKey] = useState(0);
    const pickerRef = useRef<SearchableComboboxHandle>(null);
    useEffect(() => {
      if (pickerKey > 0) pickerRef.current?.focus();
    }, [pickerKey]);

    const [savedVisible, setSavedVisible] = useState(false);
    useEffect(() => {
      if (savedNoticeKey === undefined) return;
      setSavedVisible(true);
    }, [savedNoticeKey]);

    function update(next: string[]): void {
      setSavedVisible(false);
      setNames(next);
      onNamesChange?.(next);
    }

    function addName(raw: string): void {
      setPickerKey((key) => key + 1);
      const name = normaliseRecipeTagName(raw);
      if (name.length === 0) return;
      if (name.length > RECIPE_TAG_NAME_MAX_LENGTH) {
        setError(
          `Tags must be ${String(RECIPE_TAG_NAME_MAX_LENGTH)} characters or fewer.`,
        );
        return;
      }
      const lower = name.toLowerCase();
      if (names.some((existing) => existing.toLowerCase() === lower)) {
        setError(null);
        return;
      }
      if (names.length >= RECIPE_TAGS_MAX) {
        setError(`A recipe can have at most ${String(RECIPE_TAGS_MAX)} tags.`);
        return;
      }
      setError(null);
      update([...names, name]);
    }

    const filteredSearch = useCallback(
      async (query: string): Promise<readonly SearchableComboboxOption[]> => {
        const chosen = new Set(names.map((name) => name.toLowerCase()));
        const options = await searchTags(query);
        return options.filter(
          (option) => !chosen.has(option.label.toLowerCase()),
        );
      },
      [names, searchTags],
    );

    const runSubmit = useCallback(async (): Promise<boolean> => {
      if (submitting) return false;
      const unchanged =
        names.length === initialNames.length &&
        names.every((name, index) => name === initialNames[index]);
      if (unchanged) return true;
      setSubmitting(true);
      try {
        return await onSubmit(names);
      } finally {
        setSubmitting(false);
      }
    }, [submitting, names, initialNames, onSubmit]);

    useImperativeHandle(ref, () => ({ submit: runSubmit }), [runSubmit]);

    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void runSubmit();
        }}
        className="space-y-4"
        aria-labelledby="recipe-tags-heading"
      >
        <h2 id="recipe-tags-heading" className="text-lg font-semibold">
          Tags
        </h2>

        {names.length > 0 && (
          <ul aria-label="Recipe tags" className="flex flex-wrap gap-1.5">
            {names.map((name) => (
              <li
                key={name.toLowerCase()}
                className="flex items-center gap-1 rounded-full border border-input py-0.5 pl-2.5 pr-1 text-sm"
              >
                <span>{name}</span>
                <button
                  type="button"
                  aria-label={`Remove tag ${name}`}
                  disabled={submitting}
                  className="rounded-full px-1 text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setError(null);
                    update(names.filter((existing) => existing !== name));
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="space-y-1">
          <label htmlFor="recipe-tag-input" className="text-sm font-medium">
            Add a tag
          </label>
          <SearchableCombobox
            key={pickerKey}
            ref={pickerRef}
            id="recipe-tag-input"
            value={null}
            onChange={(option) => {
              if (option) addName(option.label);
            }}
            searchQuery={filteredSearch}
            onCreate={addName}
            createLabel={(query) => `Add “${normaliseRecipeTagName(query)}”`}
            placeholder="e.g. weeknight"
            emptyMessage="Type to add a new tag"
            disabled={submitting || names.length >= RECIPE_TAGS_MAX}
          />
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        {savedVisible && (
          <p
            key={savedNoticeKey}
            role="status"
            className="text-sm text-emerald-600"
          >
            Saved.
          </p>
        )}

        {!hideSaveButton && (
          <div className="flex justify-end">
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Saving…' : 'Save tags'}
            </Button>
          </div>
        )}
      </form>
    );
  },
);
