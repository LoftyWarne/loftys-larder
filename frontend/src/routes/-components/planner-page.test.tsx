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

beforeEach(() => {
  planUseQueryMock.mockReset();
  recipesUseInfiniteQueryMock.mockReset();
  membersUseQueryMock.mockReset();
  updateMutateMock.mockReset();
  setDataMock.mockReset();
  getDataMock.mockReset();
  paramsMock.mockReset();
  searchMock.mockReset();
  mutationOptions = {};
});

describe('PlannerPage', () => {
  it('assigns the selected recipe when an empty slot is tapped', async () => {
    const user = userEvent.setup();
    setup();
    render(<PlannerPage />);

    await user.click(screen.getByRole('option', { name: /tomato pasta/i }));
    await user.click(
      screen.getByRole('button', { name: /Lunch on 2026-06-15: empty slot/i }),
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
        name: /Dinner on 2026-06-15: tomato pasta/i,
      }),
    );

    expect(
      screen.getByRole('heading', { name: /dinner.*2026-06-15/i }),
    ).toBeInTheDocument();
  });

  it('clear button on the editor sends slotType=empty', async () => {
    const user = userEvent.setup();
    setup();
    render(<PlannerPage />);

    await user.click(
      screen.getByRole('button', {
        name: /Dinner on 2026-06-15: tomato pasta/i,
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

  it('switching slot type to eat_out clears the recipe in the payload', async () => {
    const user = userEvent.setup();
    setup();
    render(<PlannerPage />);

    await user.click(
      screen.getByRole('button', {
        name: /Dinner on 2026-06-15: tomato pasta/i,
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
});
