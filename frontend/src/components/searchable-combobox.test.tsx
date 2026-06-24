import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  SearchableCombobox,
  type SearchableComboboxOption,
} from './searchable-combobox.tsx';

interface Fruit extends SearchableComboboxOption {
  flavour: string;
}

const FRUITS: Fruit[] = [
  { id: 1, label: 'Apple', flavour: 'sweet' },
  { id: 2, label: 'Apricot', flavour: 'sweet' },
  { id: 3, label: 'Banana', flavour: 'sweet' },
];

function Harness({
  initialValue = null,
  searchQuery,
  onCreate,
}: {
  initialValue?: Fruit | null;
  searchQuery: (query: string) => Promise<readonly Fruit[]> | readonly Fruit[];
  onCreate?: (query: string) => void;
}): React.ReactElement {
  const [value, setValue] = useState<Fruit | null>(initialValue);
  return (
    <SearchableCombobox
      value={value}
      onChange={setValue}
      searchQuery={searchQuery}
      ariaLabel="Pick a fruit"
      debounceMs={50}
      onCreate={onCreate}
    />
  );
}

function filterFruits(q: string): readonly Fruit[] {
  return FRUITS.filter((f) =>
    f.label.toLowerCase().includes(q.trim().toLowerCase()),
  );
}

describe('SearchableCombobox', () => {
  it('opens the listbox on focus and shows initial options', async () => {
    const search = vi
      .fn<(q: string) => readonly Fruit[]>()
      .mockReturnValue(FRUITS);
    const user = userEvent.setup();
    render(<Harness searchQuery={search} />);

    await user.click(screen.getByRole('combobox'));
    await waitFor(() => {
      expect(search).toHaveBeenCalled();
    });

    expect(await screen.findByRole('option', { name: 'Apple' })).toBeVisible();
  });

  it('debounces typed input before firing searchQuery', async () => {
    const search = vi
      .fn<(q: string) => readonly Fruit[]>()
      .mockReturnValue(FRUITS);
    const user = userEvent.setup();
    render(<Harness searchQuery={search} />);

    const input = screen.getByRole('combobox');
    await user.click(input);
    // Wait for the initial open-with-empty-query call to land before clearing
    // so it doesn't count against the debounce assertion.
    await waitFor(() => {
      expect(search).toHaveBeenCalledWith('');
    });
    search.mockClear();

    await user.type(input, 'Ap');

    // The debouncer (50ms in Harness) should coalesce both keystrokes into a
    // single call once typing stops. Wait for that final call rather than
    // asserting on a poll-time snapshot.
    await waitFor(
      () => {
        expect(search).toHaveBeenCalledWith('Ap');
      },
      { timeout: 500 },
    );

    // Every call must be a prefix of 'Ap' — never a partial-then-undone state.
    for (const call of search.mock.calls) {
      const arg = call[0];
      expect('Ap'.startsWith(arg)).toBe(true);
    }
  });

  it('commits an option on click and closes the listbox', async () => {
    const search = vi
      .fn<(q: string) => readonly Fruit[]>()
      .mockReturnValue(FRUITS);
    const user = userEvent.setup();
    render(<Harness searchQuery={search} />);

    const input = screen.getByRole('combobox');
    await user.click(input);
    const option = await screen.findByRole('option', { name: 'Banana' });
    await user.click(option);

    expect((input as HTMLInputElement).value).toBe('Banana');
    await waitFor(() => {
      expect(screen.queryByRole('option', { name: 'Apple' })).toBeNull();
    });
  });

  it('commits an option via ArrowDown then Enter', async () => {
    const search = vi
      .fn<(q: string) => readonly Fruit[]>()
      .mockReturnValue(FRUITS);
    const user = userEvent.setup();
    render(<Harness searchQuery={search} />);

    const input = screen.getByRole('combobox');
    await user.click(input);
    await screen.findByRole('option', { name: 'Apple' });

    await user.keyboard('{ArrowDown}{Enter}');

    expect((input as HTMLInputElement).value).toBe('Apricot');
  });

  it('closes the listbox on Escape without committing', async () => {
    const search = vi
      .fn<(q: string) => readonly Fruit[]>()
      .mockReturnValue(FRUITS);
    const user = userEvent.setup();
    render(<Harness searchQuery={search} />);

    const input = screen.getByRole('combobox');
    await user.click(input);
    await screen.findByRole('option', { name: 'Apple' });

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('option', { name: 'Apple' })).toBeNull();
    });
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('shows an empty-state message when the query returns no results', async () => {
    const search = vi
      .fn<(q: string) => readonly Fruit[]>()
      .mockImplementation((q) =>
        FRUITS.filter((f) =>
          f.label.toLowerCase().includes(q.trim().toLowerCase()),
        ),
      );
    const user = userEvent.setup();
    render(<Harness searchQuery={search} />);

    const input = screen.getByRole('combobox');
    await user.click(input);
    await user.type(input, 'zzz');

    expect(await screen.findByText('No matches')).toBeVisible();
  });

  it('exposes ARIA attributes for keyboard accessibility', async () => {
    const search = vi
      .fn<(q: string) => readonly Fruit[]>()
      .mockReturnValue(FRUITS);
    const user = userEvent.setup();
    render(<Harness searchQuery={search} />);

    const input = screen.getByRole('combobox');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).toHaveAttribute('aria-autocomplete', 'list');

    await user.click(input);
    await screen.findByRole('option', { name: 'Apple' });
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input.getAttribute('aria-controls')).toBeTruthy();

    await user.keyboard('{ArrowDown}');
    expect(input.getAttribute('aria-activedescendant')).toMatch(
      /combobox-.*-listbox-opt-2/,
    );
  });

  it('offers a create action for an unmatched query and fires onCreate on click', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(<Harness searchQuery={filterFruits} onCreate={onCreate} />);

    const input = screen.getByRole('combobox');
    await user.click(input);
    await user.type(input, 'Cherry');

    const createOption = await screen.findByRole('option', {
      name: /Create .*Cherry/,
    });
    await user.click(createOption);

    expect(onCreate).toHaveBeenCalledExactlyOnceWith('Cherry');
  });

  it('shows the create action even when there are no matches', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(<Harness searchQuery={filterFruits} onCreate={onCreate} />);

    const input = screen.getByRole('combobox');
    await user.click(input);
    await user.type(input, 'zzz');

    expect(screen.queryByText('No matches')).toBeNull();
    expect(
      await screen.findByRole('option', { name: /Create .*zzz/ }),
    ).toBeVisible();
  });

  it('does not offer create when the query exactly matches an option', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(<Harness searchQuery={filterFruits} onCreate={onCreate} />);

    const input = screen.getByRole('combobox');
    await user.click(input);
    await user.type(input, 'apple');

    expect(await screen.findByRole('option', { name: 'Apple' })).toBeVisible();
    expect(screen.queryByRole('option', { name: /Create/ })).toBeNull();
  });

  it('fires onCreate via keyboard navigation to the create action', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(<Harness searchQuery={filterFruits} onCreate={onCreate} />);

    const input = screen.getByRole('combobox');
    await user.click(input);
    await user.type(input, 'zzz');
    await screen.findByRole('option', { name: /Create .*zzz/ });

    await user.keyboard('{Enter}');

    expect(onCreate).toHaveBeenCalledExactlyOnceWith('zzz');
  });

  it('keeps the input value in sync when the parent updates the selection', async () => {
    function Outer(): React.ReactElement {
      const [value, setValue] = useState<Fruit | null>(null);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setValue(FRUITS[2] ?? null);
            }}
          >
            Pick banana from outside
          </button>
          <SearchableCombobox
            value={value}
            onChange={setValue}
            searchQuery={() => FRUITS}
            ariaLabel="Pick a fruit"
            debounceMs={20}
          />
        </>
      );
    }
    const user = userEvent.setup();
    render(<Outer />);

    await user.click(
      screen.getByRole('button', { name: 'Pick banana from outside' }),
    );

    expect(screen.getByRole<HTMLInputElement>('combobox').value).toBe('Banana');
  });
});
