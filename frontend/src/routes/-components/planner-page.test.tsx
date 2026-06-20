import type {
  GetPlanResult,
  ListHouseholdMembersResult,
  ListRecipesResult,
  PlanSlot,
  RecipeListItem,
  UpdateSlotInput,
} from '@loftys-larder/shared';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  planUseQueryMock,
  recipesUseInfiniteQueryMock,
  membersUseQueryMock,
  updateMutateMock,
  relocateMutateMock,
  setDataMock,
  getDataMock,
  cancelMock,
  paramsMock,
  searchMock,
} = vi.hoisted(() => ({
  planUseQueryMock: vi.fn(),
  recipesUseInfiniteQueryMock: vi.fn(),
  membersUseQueryMock: vi.fn(),
  updateMutateMock: vi.fn(),
  relocateMutateMock: vi.fn(),
  setDataMock: vi.fn(),
  getDataMock: vi.fn(),
  cancelMock: vi.fn().mockResolvedValue(undefined),
  paramsMock: vi.fn(),
  searchMock: vi.fn(),
}));

let mutationOptions: Record<string, unknown> = {};

vi.mock('@tanstack/react-router', () => ({
  useParams: () => paramsMock() as unknown,
  useSearch: () => searchMock() as unknown,
  Link: ({
    children,
    ...rest
  }: {
    children: React.ReactNode;
    to?: string;
    params?: Record<string, string>;
  }) => <a {...rest}>{children}</a>,
}));

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
      recipes: {
        list: {
          fetch: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
        },
      },
    }),
    plans: { get: { useQuery: planUseQueryMock } },
    recipes: {
      list: { useInfiniteQuery: recipesUseInfiniteQueryMock },
      get: { useQuery: vi.fn().mockReturnValue({ data: undefined }) },
    },
    user: { listHouseholdMembers: { useQuery: membersUseQueryMock } },
    slots: {
      update: {
        useMutation: (opts: Record<string, unknown>) => {
          mutationOptions = opts;
          return { mutate: updateMutateMock, isPending: false };
        },
      },
      relocate: {
        useMutation: () => ({
          mutate: relocateMutateMock,
          isPending: false,
        }),
      },
    },
  },
}));

import { PlannerPage } from './planner-page.tsx';

const TOMATO: RecipeListItem = {
  id: 10,
  name: 'Tomato pasta',
  imageUrl: null,
  baseServings: 2,
  activeTimeMins: null,
  totalTimeMins: null,
  isBase: false,
  baseRecipeId: null,
  pairedRecipeId: null,
  isDeleted: false,
  plantPointsCount: 0,
  averageRating: null,
  ratingCount: 0,
};

const EMPTY_SLOT: PlanSlot = {
  id: 100,
  planId: 9,
  date: '2026-06-15',
  occasionId: 1,
  occasionName: 'Lunch',
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

const RECIPE_SLOT: PlanSlot = {
  ...EMPTY_SLOT,
  id: 101,
  occasionId: 2,
  occasionName: 'Dinner',
  slotType: 'recipe',
  recipeId: 10,
  numberOfServings: 2,
  recipe: {
    id: 10,
    name: 'Tomato pasta',
    imageUrl: null,
    isBase: false,
    baseRecipeId: null,
    pairedRecipeId: null,
    isDeleted: false,
  },
};

const PLAN: GetPlanResult = {
  id: 9,
  startDate: '2026-06-15',
  endDate: '2026-06-15',
  createdByUserId: 'user-1',
  slots: [EMPTY_SLOT, RECIPE_SLOT],
};

interface SetupOptions {
  plan?: GetPlanResult;
  bankItems?: RecipeListItem[];
  members?: ListHouseholdMembersResult;
  search?: Record<string, string | undefined>;
  params?: Record<string, string>;
}

function setup(options: SetupOptions = {}): void {
  paramsMock.mockReturnValue(options.params ?? { planId: '9' });
  searchMock.mockReturnValue(options.search ?? {});

  planUseQueryMock.mockReturnValue({
    data: options.plan ?? PLAN,
    isLoading: false,
    error: null,
  });

  const pages: ListRecipesResult[] = [
    { items: options.bankItems ?? [TOMATO], nextCursor: null },
  ];
  recipesUseInfiniteQueryMock.mockReturnValue({
    data: { pages },
    isLoading: false,
    error: null,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    isFetchingNextPage: false,
  });

  membersUseQueryMock.mockReturnValue({
    data: options.members ?? { members: [] },
    isLoading: false,
    error: null,
  });
}

const noop = (): void => undefined;
function mockIsLargeViewport(isLarge: boolean): void {
  window.matchMedia = (query: string): MediaQueryList => {
    const mql: Partial<MediaQueryList> = {
      matches: query === '(min-width: 64rem)' ? isLarge : false,
      media: query,
      onchange: null,
      addEventListener: noop,
      removeEventListener: noop,
      addListener: noop,
      removeListener: noop,
      dispatchEvent: () => false,
    };
    return mql as MediaQueryList;
  };
}

beforeEach(() => {
  planUseQueryMock.mockReset();
  recipesUseInfiniteQueryMock.mockReset();
  membersUseQueryMock.mockReset();
  updateMutateMock.mockReset();
  relocateMutateMock.mockReset();
  setDataMock.mockReset();
  getDataMock.mockReset();
  paramsMock.mockReset();
  searchMock.mockReset();
  mutationOptions = {};
  // Default to the large-viewport branch so the bank is visible and the
  // pre-FEAT-40 click-to-assign tests keep their assertions. Tests that need
  // the compact branch (below `lg`) reassign matchMedia themselves.
  mockIsLargeViewport(true);
});

describe('PlannerPage', () => {
  it('assigns the selected recipe when an empty slot is tapped', async () => {
    const user = userEvent.setup();
    setup();
    render(<PlannerPage />);

    await user.click(screen.getByRole('option', { name: /tomato pasta/i }));
    await user.click(
      screen.getByRole('button', {
        name: /^Lunch on 2026-06-15: empty slot$/i,
      }),
    );

    expect(updateMutateMock).toHaveBeenCalledTimes(1);
    const payload = updateMutateMock.mock.calls[0]?.[0] as UpdateSlotInput;
    expect(payload).toEqual({
      slotId: 100,
      slotType: 'recipe',
      recipeId: 10,
      numberOfServings: 2,
      chefUserId: null,
      cooksBaseRecipeId: null,
      cooksBaseServings: null,
      comment: null,
    });
  });

  it('opens the slot editor when an assigned slot is tapped', async () => {
    const user = userEvent.setup();
    setup();
    render(<PlannerPage />);

    await user.click(
      screen.getByRole('button', {
        name: /^Dinner on 2026-06-15: tomato pasta$/i,
      }),
    );

    expect(
      screen.getByRole('heading', { name: /dinner.*Mon 15th Jun 2026/i }),
    ).toBeInTheDocument();
  });

  it('clear button on the editor sends slotType=empty', async () => {
    const user = userEvent.setup();
    setup();
    render(<PlannerPage />);

    await user.click(
      screen.getByRole('button', {
        name: /^Dinner on 2026-06-15: tomato pasta$/i,
      }),
    );
    await user.click(screen.getByRole('button', { name: /^clear$/i }));

    expect(updateMutateMock).toHaveBeenCalledTimes(1);
    const payload = updateMutateMock.mock.calls[0]?.[0] as UpdateSlotInput;
    expect(payload).toEqual({
      slotId: 101,
      slotType: 'empty',
      recipeId: null,
      numberOfServings: null,
      chefUserId: null,
      cooksBaseRecipeId: null,
      cooksBaseServings: null,
      comment: null,
    });
  });

  it('clearing from the slot card sends slotType=empty without opening the editor', async () => {
    const user = userEvent.setup();
    setup();
    render(<PlannerPage />);

    await user.click(
      screen.getByRole('button', {
        name: /^Clear Dinner on 2026-06-15: tomato pasta$/i,
      }),
    );

    expect(
      screen.queryByRole('heading', { name: /dinner.*Mon 15th Jun 2026/i }),
    ).not.toBeInTheDocument();
    expect(updateMutateMock).toHaveBeenCalledTimes(1);
    const payload = updateMutateMock.mock.calls[0]?.[0] as UpdateSlotInput;
    expect(payload).toEqual({
      slotId: 101,
      slotType: 'empty',
      recipeId: null,
      numberOfServings: null,
      chefUserId: null,
      cooksBaseRecipeId: null,
      cooksBaseServings: null,
      comment: null,
    });
  });

  it('switching slot type to eat_out clears the recipe in the payload', async () => {
    const user = userEvent.setup();
    setup();
    render(<PlannerPage />);

    await user.click(
      screen.getByRole('button', {
        name: /^Dinner on 2026-06-15: tomato pasta$/i,
      }),
    );
    await user.click(screen.getByRole('radio', { name: /eat out/i }));
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(updateMutateMock).toHaveBeenCalledTimes(1);
    const payload = updateMutateMock.mock.calls[0]?.[0] as UpdateSlotInput;
    expect(payload).toMatchObject({
      slotId: 101,
      slotType: 'eat_out',
      recipeId: null,
      numberOfServings: null,
    });
  });

  it('surfaces the error toast and rolls back when the mutation fails', () => {
    setup();
    render(<PlannerPage />);

    const onError = mutationOptions.onError as (
      err: unknown,
      vars: unknown,
      ctx: { previous: GetPlanResult | undefined } | undefined,
    ) => void;

    getDataMock.mockReturnValue(PLAN);
    act(() => {
      onError(new Error('boom'), {}, { previous: PLAN });
    });

    expect(setDataMock).toHaveBeenCalledWith({ id: 9 }, PLAN);
    expect(screen.getByRole('alert')).toHaveTextContent(/boom/i);
  });

  it('clamps the visible range using URL search params', () => {
    setup({
      plan: {
        ...PLAN,
        startDate: '2026-06-15',
        endDate: '2026-06-20',
        slots: [
          { ...EMPTY_SLOT, date: '2026-06-15' },
          { ...EMPTY_SLOT, id: 200, date: '2026-06-20' },
        ],
      },
      search: { start: '2026-06-15', end: '2026-06-15' },
    });
    render(<PlannerPage />);

    // Visible range collapsed to the first day — second slot's date label
    // (Jun 20) should be absent.
    expect(screen.queryByText(/20 Jun/)).not.toBeInTheDocument();
  });

  // FEAT-40 — two interaction shapes gated on `lg`. Below `lg`: no Recipe
  // Bank, slot taps open the editor — but slot ↔ slot drag still works.
  // At `lg+`: bank visible alongside the grid, full DnD active, click-to-
  // assign still works.
  describe('responsive interaction shape', () => {
    it('hides the Recipe Bank below the `lg` breakpoint', () => {
      mockIsLargeViewport(false);
      setup();
      render(<PlannerPage />);

      expect(
        screen.queryByRole('listbox', { name: /pickable recipes/i }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('option', { name: /tomato pasta/i }),
      ).not.toBeInTheDocument();
    });

    it('opens the editor when an empty slot is tapped below `lg`', async () => {
      mockIsLargeViewport(false);
      const user = userEvent.setup();
      setup();
      render(<PlannerPage />);

      await user.click(
        screen.getByRole('button', {
          name: /^Lunch on 2026-06-15: empty slot$/i,
        }),
      );

      expect(
        screen.getByRole('heading', { name: /lunch.*Mon 15th Jun 2026/i }),
      ).toBeInTheDocument();
      expect(updateMutateMock).not.toHaveBeenCalled();
    });

    it('keeps slot ↔ slot DnD wired below `lg` (cursor-grab on populated slots)', () => {
      mockIsLargeViewport(false);
      setup();
      render(<PlannerPage />);

      // No bank, but populated slot cards are still draggable + droppable
      // so users can move / swap meals on a phone or portrait tablet.
      const slotButton = screen.getByRole('button', {
        name: /^Dinner on 2026-06-15: tomato pasta$/i,
      });
      expect(slotButton.className).toContain('cursor-grab');
    });

    it('mounts the bank and full DnD wiring at `lg+`', () => {
      mockIsLargeViewport(true);
      setup();
      render(<PlannerPage />);

      const row = screen.getByRole('option', { name: /tomato pasta/i });
      expect(row).toBeInTheDocument();
      // The grab cursor on a bank row and a populated slot card is the
      // visible signal that the DnD path is mounted.
      expect(row.className).toContain('cursor-grab');
      const slotButton = screen.getByRole('button', {
        name: /^Dinner on 2026-06-15: tomato pasta$/i,
      });
      expect(slotButton.className).toContain('cursor-grab');
    });
  });
});
