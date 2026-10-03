import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RecipeFilters } from '@/lib/recipe-filters.ts';

const {
  listTagsUseQueryMock,
  listSourcesUseQueryMock,
  listIngredientsUseQueryMock,
} = vi.hoisted(() => ({
  listTagsUseQueryMock: vi.fn(),
  listSourcesUseQueryMock: vi.fn(),
  listIngredientsUseQueryMock: vi.fn(),
}));

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    recipes: {
      listTags: { useQuery: listTagsUseQueryMock },
      listSources: { useQuery: listSourcesUseQueryMock },
      listIngredients: { useQuery: listIngredientsUseQueryMock },
    },
  },
}));

import { RecipeFilterBar } from './recipe-filter-bar.tsx';

const TAGS = [
  { id: 1, name: 'Quick' },
  { id: 2, name: 'Vegetarian' },
];
const SOURCES = [
  { id: 10, name: 'BBC Good Food' },
  { id: 11, name: 'Mob Kitchen' },
];
const INGREDIENTS = [
  { id: 20, name: 'Chicken' },
  { id: 21, name: 'Chickpeas' },
  { id: 22, name: 'Leek' },
];

// Holds the filters the way the page's URL does, and records each patch.
function Harness({
  initial = {},
  onChange,
}: {
  initial?: RecipeFilters;
  onChange: (patch: RecipeFilters) => void;
}): React.ReactElement {
  const [filters, setFilters] = useState<RecipeFilters>(initial);
  return (
    <RecipeFilterBar
      filters={filters}
      onChange={(patch) => {
        onChange(patch);
        setFilters((prev) => ({ ...prev, ...patch }));
      }}
    />
  );
}

beforeEach(() => {
  listTagsUseQueryMock.mockReset().mockReturnValue({ data: TAGS });
  listSourcesUseQueryMock.mockReset().mockReturnValue({ data: SOURCES });
  listIngredientsUseQueryMock
    .mockReset()
    .mockReturnValue({ data: INGREDIENTS });
});

describe('RecipeFilterBar', () => {
  it('shows a button per filter, all unset', () => {
    render(<Harness onChange={vi.fn()} />);
    const bar = screen.getByRole('group', { name: 'Filter recipes' });
    expect(
      within(bar)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Tags', 'Source', 'Total time', 'Active time', 'Ingredients']);
  });

  it('hides tags, source and ingredients when there is nothing to pick', () => {
    listTagsUseQueryMock.mockReturnValue({ data: [] });
    listSourcesUseQueryMock.mockReturnValue({ data: undefined });
    listIngredientsUseQueryMock.mockReturnValue({ data: [] });
    render(<Harness onChange={vi.fn()} />);
    const bar = screen.getByRole('group', { name: 'Filter recipes' });
    expect(
      within(bar)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Total time', 'Active time']);
  });

  it('picks tags from a checklist and names the selection on the button', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Tags' }));
    const panel = screen.getByRole('dialog', { name: 'Tags' });
    await user.click(within(panel).getByRole('checkbox', { name: 'Quick' }));

    expect(onChange).toHaveBeenLastCalledWith({ tags: [1] });
    expect(
      screen.getByRole('button', { name: 'Tags: Quick' }),
    ).toBeInTheDocument();

    await user.click(
      within(panel).getByRole('checkbox', { name: 'Vegetarian' }),
    );
    expect(onChange).toHaveBeenLastCalledWith({ tags: [1, 2] });
    expect(
      screen.getByRole('button', { name: 'Tags: 2 selected' }),
    ).toBeInTheDocument();

    await user.click(within(panel).getByRole('checkbox', { name: 'Quick' }));
    await user.click(
      within(panel).getByRole('checkbox', { name: 'Vegetarian' }),
    );
    expect(onChange).toHaveBeenLastCalledWith({ tags: undefined });
    expect(screen.getByRole('button', { name: 'Tags' })).toBeInTheDocument();
  });

  it('picks sources and clears them from the panel', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Source' }));
    const panel = screen.getByRole('dialog', { name: 'Source' });
    await user.click(
      within(panel).getByRole('checkbox', { name: 'Mob Kitchen' }),
    );
    expect(onChange).toHaveBeenLastCalledWith({ sources: [11] });

    await user.click(within(panel).getByRole('button', { name: 'Clear' }));
    expect(onChange).toHaveBeenLastCalledWith({ sources: undefined });
    expect(
      within(panel).getByRole('checkbox', { name: 'Mob Kitchen' }),
    ).not.toBeChecked();
  });

  it('sets total and active time limits separately', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Total time' }));
    await user.click(screen.getByRole('radio', { name: 'Up to 30 min' }));
    expect(onChange).toHaveBeenLastCalledWith({ maxTotal: 30 });
    expect(
      screen.getByRole('button', { name: 'Total time: up to 30 min' }),
    ).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Active time' }));
    const panel = screen.getByRole('dialog', { name: 'Active time' });
    expect(within(panel).getByRole('radio', { name: 'Any' })).toBeChecked();
    await user.click(
      within(panel).getByRole('radio', { name: 'Up to 15 min' }),
    );
    expect(onChange).toHaveBeenLastCalledWith({ maxActive: 15 });

    await user.click(within(panel).getByRole('radio', { name: 'Any' }));
    expect(onChange).toHaveBeenLastCalledWith({ maxActive: undefined });
  });

  it('adds ingredients by search, then removes them', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Ingredients' }));
    const panel = screen.getByRole('dialog', { name: 'Ingredients' });
    await user.type(
      within(panel).getByRole('combobox', { name: 'Find an ingredient' }),
      'chick',
    );
    await user.click(await screen.findByRole('option', { name: 'Chickpeas' }));
    expect(onChange).toHaveBeenLastCalledWith({ ingredients: [21] });

    // The picker clears and keeps focus, and doesn't offer a picked one again.
    const picker = within(panel).getByRole('combobox', {
      name: 'Find an ingredient',
    });
    await waitFor(() => {
      expect(picker).toHaveFocus();
    });
    expect(picker).toHaveValue('');
    await user.type(picker, 'chick');
    await waitFor(() => {
      expect(
        screen.getAllByRole('option').map((option) => option.textContent),
      ).toEqual(['Chicken']);
    });
    await user.click(screen.getByRole('option', { name: 'Chicken' }));
    expect(onChange).toHaveBeenLastCalledWith({ ingredients: [21, 20] });
    expect(
      screen.getByRole('button', { name: 'Ingredients: 2 selected' }),
    ).toBeInTheDocument();

    await user.click(
      within(panel).getByRole('button', { name: 'Remove Chickpeas' }),
    );
    expect(onChange).toHaveBeenLastCalledWith({ ingredients: [20] });
    expect(
      within(panel).getByRole('list', { name: 'Selected ingredients' }),
    ).toHaveTextContent('Chicken');
  });

  it('stops adding ingredients at the limit', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      name: `Ingredient ${String(index + 1)}`,
    }));
    listIngredientsUseQueryMock.mockReturnValue({ data: many });
    render(
      <Harness
        initial={{ ingredients: many.map((item) => item.id) }}
        onChange={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole('button', { name: 'Ingredients: 10 selected' }),
    );
    expect(
      screen.getByRole('combobox', { name: 'Find an ingredient' }),
    ).toBeDisabled();
  });

  it('clears every filter at once, and only offers that while one is set', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Harness
        initial={{ tags: [1], sources: [10], ingredients: [20], maxTotal: 60 }}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));

    expect(onChange).toHaveBeenLastCalledWith({
      tags: undefined,
      sources: undefined,
      ingredients: undefined,
      maxTotal: undefined,
      maxActive: undefined,
    });
    expect(
      screen.queryByRole('button', { name: 'Clear filters' }),
    ).not.toBeInTheDocument();
  });
});
