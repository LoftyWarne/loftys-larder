import * as PopoverPrimitive from '@radix-ui/react-popover';
import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';

import { Input } from '@/components/ui/input.tsx';
import { cn } from '@/lib/utils.ts';

export interface SearchableComboboxOption {
  id: number;
  label: string;
}

export interface SearchableComboboxProps<T extends SearchableComboboxOption> {
  value: T | null;
  onChange: (option: T | null) => void;
  searchQuery: (query: string) => Promise<readonly T[]> | readonly T[];
  placeholder?: string;
  debounceMs?: number;
  disabled?: boolean;
  ariaLabel?: string;
  id?: string;
  emptyMessage?: string;
  className?: string;
  inputClassName?: string;
  // When set, a "create" action is offered in the listbox whenever the trimmed
  // input is non-empty and doesn't exactly match an existing option (case
  // insensitive). Selecting it calls `onCreate` with the trimmed query and
  // closes the listbox — the caller decides what creating means. Keeps the
  // primitive generic (FEAT-21): ingredient is the first consumer, others opt
  // out by leaving it undefined.
  onCreate?: (query: string) => void;
  createLabel?: (query: string) => string;
  // When set (alongside `onCreate`), blurring the input while it holds a
  // settled, unmatched query fires the create action automatically — the same
  // path as picking "Create …" from the list. Only fires for a genuinely
  // unknown name (no exact match, nothing selected); an exact match or a
  // still-debouncing value is left alone. Opt-in so the other pickers that
  // reuse this primitive (FEAT-23/26/31/32) keep their click-to-create-only
  // behaviour.
  createOnBlur?: boolean;
  // Custom rendering for an option row. Defaults to `option.label`. Lets a
  // consumer add a right-aligned adornment (e.g. a type badge) without forking
  // the primitive (FEAT-21). The string `label` is still used for matching,
  // the input value, and the create-action comparison.
  renderOption?: (option: T) => ReactNode;
}

export interface SearchableComboboxHandle {
  focus: () => void;
}

const DEFAULT_DEBOUNCE_MS = 200;
const EMPTY_MESSAGE_DEFAULT = 'No matches';

function SearchableComboboxInner<T extends SearchableComboboxOption>(
  props: SearchableComboboxProps<T>,
  ref: Ref<SearchableComboboxHandle>,
): ReactElement {
  const {
    value,
    onChange,
    searchQuery,
    placeholder,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    disabled,
    ariaLabel,
    id,
    emptyMessage = EMPTY_MESSAGE_DEFAULT,
    className,
    inputClassName,
    onCreate,
    createLabel,
    createOnBlur,
    renderOption,
  } = props;

  const generatedId = useId();
  const inputId = id ?? `combobox-${generatedId}`;
  const listboxId = `${inputId}-listbox`;

  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
  }));

  const [inputValue, setInputValue] = useState<string>(value?.label ?? '');
  const [debouncedQuery, setDebouncedQuery] = useState<string>('');
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<readonly T[]>([]);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const [searching, setSearching] = useState(false);

  // Keep the displayed text in sync when the parent swaps the selection.
  useEffect(() => {
    setInputValue(value?.label ?? '');
  }, [value]);

  // Debounce the query — the search is only fired after the user stops
  // typing for `debounceMs`.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedQuery(inputValue.trim());
    }, debounceMs);
    return () => {
      window.clearTimeout(handle);
    };
  }, [inputValue, debounceMs]);

  // Run the search whenever the debounced query changes AND the listbox is
  // open. A closed listbox skips the work — typing-then-blurring shouldn't
  // fire a search.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSearching(true);
    void Promise.resolve(searchQuery(debouncedQuery))
      .then((results) => {
        if (cancelled) return;
        setOptions(results);
        const willShowCreate =
          onCreate !== undefined &&
          debouncedQuery.length > 0 &&
          !results.some(
            (o) => o.label.toLowerCase() === debouncedQuery.toLowerCase(),
          );
        setActiveIndex(results.length > 0 || willShowCreate ? 0 : -1);
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, open, searchQuery, onCreate]);

  // The create action is offered against the *searched* query (`debouncedQuery`)
  // so it stays in lockstep with the options list — `activeIndex` is computed
  // from the same basis in the search effect. The create item sits at index
  // `options.length`, one past the last option.
  const showCreate =
    onCreate !== undefined &&
    debouncedQuery.length > 0 &&
    !options.some(
      (o) => o.label.toLowerCase() === debouncedQuery.toLowerCase(),
    );
  const navCount = options.length + (showCreate ? 1 : 0);
  const createActive = showCreate && activeIndex === options.length;
  const createId = `${listboxId}-create`;

  const activeId = useMemo(() => {
    if (createActive) return createId;
    if (activeIndex < 0 || activeIndex >= options.length) return undefined;
    const option = options[activeIndex];
    return option ? `${listboxId}-opt-${String(option.id)}` : undefined;
  }, [activeIndex, options, listboxId, createActive, createId]);

  function fireCreate(): void {
    onCreate?.(debouncedQuery);
    setOpen(false);
  }

  function commit(option: T): void {
    onChange(option);
    setInputValue(option.label);
    setOpen(false);
  }

  function clearSelection(): void {
    onChange(null);
    setInputValue('');
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setActiveIndex((index) => {
        if (navCount === 0) return -1;
        return (index + 1) % navCount;
      });
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setActiveIndex((index) => {
        if (navCount === 0) return -1;
        return (index - 1 + navCount) % navCount;
      });
      return;
    }
    if (event.key === 'Enter') {
      if (open && activeIndex >= 0) {
        event.preventDefault();
        if (createActive) {
          fireCreate();
          return;
        }
        const option = options[activeIndex];
        if (option) commit(option);
      }
      return;
    }
    if (event.key === 'Escape') {
      if (open) {
        event.preventDefault();
        setOpen(false);
      }
    }
  }

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        // Only react to Radix's own close requests (outside-click). Open is
        // driven by the input.
        if (!next) setOpen(false);
      }}
    >
      <PopoverPrimitive.Anchor asChild>
        <div className={cn('relative', className)}>
          <Input
            ref={inputRef}
            id={inputId}
            type="text"
            role="combobox"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            placeholder={placeholder}
            aria-label={ariaLabel}
            aria-expanded={open}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={activeId}
            value={inputValue}
            className={inputClassName}
            onChange={(event) => {
              setInputValue(event.target.value);
              setOpen(true);
              // Clear the upstream selection as soon as the text stops
              // matching it — prevents the caller from holding a stale value.
              if (value && event.target.value !== value.label) {
                onChange(null);
              }
            }}
            onFocus={() => {
              setOpen(true);
            }}
            onBlur={() => {
              // Auto-open create only for a settled, unmatched name. `showCreate`
              // already encodes "onCreate set, non-empty, no exact match"; the
              // extra guards ensure nothing is selected and the debounced search
              // is caught up to what's in the box (so a mid-type blur can't fire
              // a false "unknown"). Committing an option / clicking the create
              // row can't reach here — both suppress blur via onMouseDown.
              if (!createOnBlur) return;
              if (value !== null) return;
              if (!showCreate) return;
              if (debouncedQuery !== inputValue.trim()) return;
              fireCreate();
            }}
            onKeyDown={handleKeyDown}
          />
          {value !== null && !disabled && (
            <button
              type="button"
              aria-label="Clear selection"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={clearSelection}
            >
              ×
            </button>
          )}
        </div>
      </PopoverPrimitive.Anchor>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          id={listboxId}
          role="listbox"
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
          }}
          className="z-50 max-h-60 w-[var(--radix-popover-trigger-width)] overflow-auto rounded-md border border-input bg-popover p-1 text-sm shadow-md"
        >
          {searching && options.length === 0 && !showCreate ? (
            <p role="status" className="p-2 text-muted-foreground">
              Searching…
            </p>
          ) : options.length === 0 && !showCreate ? (
            <p role="status" className="p-2 text-muted-foreground">
              {emptyMessage}
            </p>
          ) : (
            <ul>
              {options.map((option, index) => {
                const optionId = `${listboxId}-opt-${String(option.id)}`;
                const isActive = index === activeIndex;
                return (
                  <li
                    key={option.id}
                    id={optionId}
                    role="option"
                    aria-selected={isActive}
                    className={cn(
                      'cursor-pointer rounded-sm px-2 py-1.5',
                      isActive ? 'bg-accent text-accent-foreground' : '',
                    )}
                    onMouseDown={(event) => {
                      // Prevent the input from blurring (which would close the
                      // listbox) before the click handler can fire.
                      event.preventDefault();
                    }}
                    onMouseEnter={() => {
                      setActiveIndex(index);
                    }}
                    onClick={() => {
                      commit(option);
                    }}
                  >
                    {renderOption ? renderOption(option) : option.label}
                  </li>
                );
              })}
              {showCreate && (
                <li
                  id={createId}
                  role="option"
                  aria-selected={createActive}
                  className={cn(
                    'cursor-pointer rounded-sm px-2 py-1.5',
                    createActive ? 'bg-accent text-accent-foreground' : '',
                  )}
                  onMouseDown={(event) => {
                    event.preventDefault();
                  }}
                  onMouseEnter={() => {
                    setActiveIndex(options.length);
                  }}
                  onClick={() => {
                    fireCreate();
                  }}
                >
                  {createLabel
                    ? createLabel(debouncedQuery)
                    : `Create “${debouncedQuery}”`}
                </li>
              )}
            </ul>
          )}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

export const SearchableCombobox = forwardRef(SearchableComboboxInner) as <
  T extends SearchableComboboxOption,
>(
  props: SearchableComboboxProps<T> & { ref?: Ref<SearchableComboboxHandle> },
) => ReactElement;
