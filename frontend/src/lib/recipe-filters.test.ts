import { describe, expect, it } from 'vitest';

import {
  hasRecipeFilters,
  idsOrUndefined,
  listInputFromSearch,
  NO_RECIPE_FILTERS,
  selectionSummary,
} from './recipe-filters.ts';

describe('listInputFromSearch', () => {
  it('maps every URL key onto the list input', () => {
    expect(
      listInputFromSearch(
        {
          q: 'pie',
          tags: [1],
          sources: [2, 3],
          ingredients: [4],
          maxTotal: 60,
          maxActive: 15,
        },
        30,
      ),
    ).toEqual({
      search: 'pie',
      tagIds: [1],
      sourceIds: [2, 3],
      ingredientIds: [4],
      maxTotalTimeMins: 60,
      maxActiveTimeMins: 15,
      limit: 30,
    });
  });

  it('leaves absent keys undefined', () => {
    expect(listInputFromSearch({}, 30)).toEqual({
      search: undefined,
      tagIds: undefined,
      sourceIds: undefined,
      ingredientIds: undefined,
      maxTotalTimeMins: undefined,
      maxActiveTimeMins: undefined,
      limit: 30,
    });
  });
});

describe('hasRecipeFilters', () => {
  it('is false with nothing set, and ignores the name search', () => {
    expect(hasRecipeFilters({})).toBe(false);
    expect(hasRecipeFilters(NO_RECIPE_FILTERS)).toBe(false);
    const searchOnly: Parameters<typeof hasRecipeFilters>[0] & { q: string } = {
      q: 'pie',
    };
    expect(hasRecipeFilters(searchOnly)).toBe(false);
  });

  it('is true when any one filter is set', () => {
    expect(hasRecipeFilters({ tags: [1] })).toBe(true);
    expect(hasRecipeFilters({ sources: [1] })).toBe(true);
    expect(hasRecipeFilters({ ingredients: [1] })).toBe(true);
    expect(hasRecipeFilters({ maxTotal: 30 })).toBe(true);
    expect(hasRecipeFilters({ maxActive: 30 })).toBe(true);
  });
});

describe('selectionSummary', () => {
  const options = [
    { id: 1, name: 'Mob Kitchen' },
    { id: 2, name: 'BBC Good Food' },
  ];

  it('is null with nothing selected', () => {
    expect(selectionSummary([], options)).toBeNull();
  });

  it('names a single selection', () => {
    expect(selectionSummary([2], options)).toBe('BBC Good Food');
  });

  it('counts several selections, or one whose name is not loaded', () => {
    expect(selectionSummary([1, 2], options)).toBe('2 selected');
    expect(selectionSummary([9], options)).toBe('1 selected');
  });
});

describe('idsOrUndefined', () => {
  it('writes an empty selection as absent', () => {
    expect(idsOrUndefined([])).toBeUndefined();
    expect(idsOrUndefined([3, 1])).toEqual([3, 1]);
  });
});
