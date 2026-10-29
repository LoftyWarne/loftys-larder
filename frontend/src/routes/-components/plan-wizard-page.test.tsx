import type {
  CreatePlanWithSlotsInput,
  ProposePlanInput,
  ProposePlanResult,
  ProposedSlot,
} from '@loftys-larder/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TRPCClientError } from '@trpc/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  navigateMock,
  blockerMock,
  checkDatesMock,
  membersFetchMock,
  recipesFetchMock,
  invalidateMock,
  proposeMock,
  applyMock,
  figuresQueryMock,
} = vi.hoisted(() => ({
  navigateMock: vi.fn().mockResolvedValue(undefined),
  blockerMock: vi.fn(),
  checkDatesMock: vi.fn(),
  membersFetchMock: vi.fn(),
  recipesFetchMock: vi.fn(),
  invalidateMock: vi.fn().mockResolvedValue(undefined),
  proposeMock: vi.fn(),
  applyMock: vi.fn(),
  figuresQueryMock: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
  useBlocker: (options: unknown) => blockerMock(options) as unknown,
  Link: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props}>{props.children}</a>
  ),
}));

vi.mock('@/lib/date-utils.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/date-utils.ts')>()),
  todayInLondon: () => '2026-11-01',
}));

const MEMBERS = [
  { id: 'ann', name: 'Ann' },
  { id: 'bo', name: 'Bo' },
];

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    useUtils: () => ({
      plans: {
        checkNewDates: { fetch: checkDatesMock },
        list: { invalidate: invalidateMock },
      },
      user: { listHouseholdMembers: { fetch: membersFetchMock } },
      recipes: { list: { fetch: recipesFetchMock } },
    }),
    user: {
      listHouseholdMembers: {
        useQuery: () => ({ data: { members: MEMBERS } }),
      },
    },
    planProposals: {
      propose: {
        useMutation: () => ({ mutateAsync: proposeMock, isPending: false }),
      },
    },
    plans: {
      createWithSlots: {
        useMutation: () => ({ mutateAsync: applyMock, isPending: false }),
      },
      proposedFigures: { useQuery: figuresQueryMock },
    },
  },
}));

import { PlanWizardPage } from './plan-wizard-page.tsx';

const LUNCH = { id: 1, name: 'Lunch' };
const DINNER = { id: 2, name: 'Dinner' };
const MON = '2026-11-02';
const TUE = '2026-11-03';

function suggestion(
  date: string,
  occasionId: number,
  recipeId: number,
  name: string,
): ProposedSlot {
  return {
    date,
    occasionId,
    slotType: 'recipe',
    leftoversSource: null,
    items: [
      {
        recipeId,
        prepared: 2,
        eaten: 2,
        recipeName: name,
        recipeImageUrl: null,
        isBase: false,
        baseRecipeId: null,
      },
    ],
    reason: `Why ${name}`,
  };
}

const PROPOSAL: ProposePlanResult = {
  slots: [
    suggestion(MON, LUNCH.id, 21, 'Lentil Soup'),
    suggestion(MON, DINNER.id, 22, 'Bean Chilli'),
    suggestion(TUE, LUNCH.id, 23, 'Green Salad'),
    suggestion(TUE, DINNER.id, 24, 'Fish Pie'),
  ],
  summary: 'A light week.',
  dropped: 1,
};

function domainError(code: string, extra: Record<string, unknown> = {}) {
  return new TRPCClientError(code, {
    result: {
      error: {
        message: code,
        code: -32_600,
        data: { code: 'BAD_REQUEST', cause: { code, ...extra } },
      },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  blockerMock.mockReturnValue({ status: 'idle' });
  checkDatesMock.mockResolvedValue({ occasions: [LUNCH, DINNER] });
  membersFetchMock.mockResolvedValue({ members: MEMBERS });
  recipesFetchMock.mockResolvedValue({
    items: [
      {
        id: 31,
        name: 'Sunday Roast',
        imageUrl: null,
        isBase: false,
        baseRecipeId: null,
        isDeleted: false,
      },
    ],
  });
  proposeMock.mockResolvedValue(PROPOSAL);
  applyMock.mockResolvedValue({ plan: { id: 77 } });
  figuresQueryMock.mockReturnValue({
    data: {
      days: [
        {
          date: MON,
          plantPoints: 5,
          healthScore: { average: 7, notScored: 0, includesOutOfDate: false },
        },
      ],
      plan: {
        plantPoints: 9,
        healthScore: { average: 6.5, notScored: 0, includesOutOfDate: false },
      },
    },
  });
});

async function finishDates(user: ReturnType<typeof userEvent.setup>) {
  fireEvent.change(screen.getByLabelText('Start date'), {
    target: { value: MON },
  });
  fireEvent.change(screen.getByLabelText('End date'), {
    target: { value: TUE },
  });
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByRole('heading', { name: 'Who’s eating?' });
}

async function toReview(user: ReturnType<typeof userEvent.setup>) {
  await finishDates(user);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Plan my meals' }));
  await screen.findByRole('heading', { name: /^Review/ });
}

function lastProposeInput(): ProposePlanInput {
  return proposeMock.mock.lastCall?.[0] as ProposePlanInput;
}

describe('the dates step', () => {
  it('refuses a range with plan creation’s message and stays put', async () => {
    const user = userEvent.setup();
    checkDatesMock.mockRejectedValueOnce(domainError('PLAN_DATE_OVERLAP'));
    render(<PlanWizardPage />);

    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That range overlaps an existing active or future plan.',
    );
    expect(screen.getByRole('heading', { name: 'Which dates?' })).toBeVisible();
  });

  it('refuses an end before the start before asking the server', async () => {
    const user = userEvent.setup();
    render(<PlanWizardPage />);
    fireEvent.change(screen.getByLabelText('End date'), {
      target: { value: '2026-10-30' },
    });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'End date must be on or after start date',
    );
    expect(checkDatesMock).not.toHaveBeenCalled();
  });
});

describe('who’s eating and Fixed meals', () => {
  it('defaults to everyone, takes overrides at each level, and keeps them going back', async () => {
    const user = userEvent.setup();
    render(<PlanWizardPage />);
    await finishDates(user);

    expect(screen.getAllByText('2 eating')).toHaveLength(4);
    // Every meal: add a guest.
    const guests = screen.getByLabelText('Guests, every meal');
    await user.clear(guests);
    await user.type(guests, '1');
    expect(screen.getAllByText('3 eating')).toHaveLength(4);
    // Dinner: just Ann.
    await user.click(screen.getByLabelText('Different for Dinner'));
    const dinner = screen.getByRole('group', { name: 'Dinner' });
    await user.click(within(dinner).getByText('Bo'));
    expect(screen.getAllByText('2 eating')).toHaveLength(2);
    // One slot: nobody.
    await user.click(
      screen.getByRole('button', { name: /^Nobody eating, Lunch, Mon/ }),
    );
    expect(screen.getByText('Nobody eating')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Nobody eating')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Plan my meals' }));

    expect(
      lastProposeInput().slots.map((slot) => [
        slot.dinerUserIds,
        slot.guestCount,
      ]),
    ).toEqual([
      [[], 0],
      [['ann'], 1],
      [['ann', 'bo'], 1],
      [['ann'], 1],
    ]);
  });

  it('fixes a slot to a recipe, eat out or takeaway, but never leftovers', async () => {
    const user = userEvent.setup();
    render(<PlanWizardPage />);
    await finishDates(user);
    await user.click(screen.getByRole('button', { name: 'Next' }));

    const lunch = screen.getByLabelText(/^Fixed meal, Lunch, Mon/);
    expect(
      within(lunch)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      'Plan it for me',
      'A recipe',
      'A batch to cook',
      'Eat out',
      'Takeaway',
    ]);
    await user.selectOptions(lunch, 'recipe');
    await user.type(screen.getByLabelText(/^Recipe, Lunch, Mon/), 'Roast');
    await user.click(
      await screen.findByRole('option', { name: /Sunday Roast/ }),
    );
    expect(screen.getByText('Sunday Roast')).toBeVisible();
    await user.selectOptions(
      screen.getByLabelText(/^Fixed meal, Dinner, Mon/),
      'takeaway',
    );
    await user.selectOptions(
      screen.getByLabelText(/^Fixed meal, Lunch, Tue/),
      'eat_out',
    );
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Plan my meals' }));

    expect(lastProposeInput().slots.map((slot) => slot.fixed)).toEqual([
      { kind: 'recipe', recipeId: 31 },
      { kind: 'takeaway' },
      { kind: 'eat_out' },
      null,
    ]);
  });

  it('fixes a Batch, refusing fewer portions than the slot’s headcount', async () => {
    const user = userEvent.setup();
    render(<PlanWizardPage />);
    await finishDates(user);
    await user.click(screen.getByRole('button', { name: 'Next' }));

    await user.selectOptions(
      screen.getByLabelText(/^Fixed meal, Dinner, Mon/),
      'batch',
    );
    await user.type(screen.getByLabelText(/^Recipe, Dinner, Mon/), 'Roast');
    await user.click(
      await screen.findByRole('option', { name: /Sunday Roast/ }),
    );
    const portions = screen.getByLabelText('Portions cooked');
    expect(portions).toHaveValue(4);
    expect(portions).toHaveAccessibleDescription(
      '2 eat it here. The rest is planned for later in the plan.',
    );

    await user.clear(portions);
    await user.type(portions, '1');
    expect(portions).toHaveAccessibleDescription(
      'Cook at least 2 portions: everyone eating here eats it.',
    );
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

    await user.clear(portions);
    await user.type(portions, '6');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Plan my meals' }));

    expect(lastProposeInput().slots[1]?.fixed).toEqual({
      kind: 'batch',
      recipeId: 31,
      portions: 6,
    });
  });

  it('keeps a Batch whose slot grew past its portions, asking for more', async () => {
    const user = userEvent.setup();
    render(<PlanWizardPage />);
    await finishDates(user);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.selectOptions(
      screen.getByLabelText(/^Fixed meal, Dinner, Mon/),
      'batch',
    );
    await user.type(screen.getByLabelText(/^Recipe, Dinner, Mon/), 'Roast');
    await user.click(
      await screen.findByRole('option', { name: /Sunday Roast/ }),
    );

    await user.click(screen.getByRole('button', { name: 'Back' }));
    const guests = screen.getByLabelText('Guests, every meal');
    await user.clear(guests);
    await user.type(guests, '3');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(
      screen.getByRole('button', { name: /^Change recipe, Dinner, Mon/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('Sunday Roast')).toBeInTheDocument();
    expect(
      screen.getByLabelText('Portions cooked'),
    ).toHaveAccessibleDescription(
      'Cook at least 5 portions: everyone eating here eats it.',
    );
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('fixes a Batch where nobody eats, but not a recipe', async () => {
    const user = userEvent.setup();
    render(<PlanWizardPage />);
    await finishDates(user);
    await user.click(
      screen.getByRole('button', { name: /^Nobody eating, Lunch, Mon/ }),
    );
    await user.click(screen.getByRole('button', { name: 'Next' }));

    const lunch = screen.getByLabelText(/^Fixed meal, Lunch, Mon/);
    expect(
      within(lunch).getByRole('option', { name: 'A recipe' }),
    ).toBeDisabled();
    await user.selectOptions(lunch, 'batch');
    await user.type(screen.getByLabelText(/^Recipe, Lunch, Mon/), 'Roast');
    await user.click(
      await screen.findByRole('option', { name: /Sunday Roast/ }),
    );
    expect(
      screen.getByLabelText('Portions cooked'),
    ).toHaveAccessibleDescription(
      'Nobody eats it here. It’s all planned for later in the plan.',
    );
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Plan my meals' }));

    expect(lastProposeInput().slots[0]).toMatchObject({
      dinerUserIds: [],
      fixed: { kind: 'batch', recipeId: 31, portions: 4 },
    });
  });

  it('drops a Fixed meal whose date left the range, so it can’t return where nobody eats', async () => {
    const user = userEvent.setup();
    render(<PlanWizardPage />);
    await finishDates(user);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.selectOptions(
      screen.getByLabelText(/^Fixed meal, Dinner, Tue/),
      'recipe',
    );
    await user.type(screen.getByLabelText(/^Recipe, Dinner, Tue/), 'Roast');
    await user.click(
      await screen.findByRole('option', { name: /Sunday Roast/ }),
    );

    // Shorten the range to Monday, then set every meal to nobody.
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.change(screen.getByLabelText('End date'), {
      target: { value: MON },
    });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Who’s eating?' });
    const everyMeal = screen.getByRole('group', { name: 'every meal' });
    await user.click(within(everyMeal).getByText('Ann'));
    await user.click(within(everyMeal).getByText('Bo'));

    // Widen it again: Tuesday dinner is no longer fixed.
    await user.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.change(screen.getByLabelText('End date'), {
      target: { value: TUE },
    });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Who’s eating?' });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByLabelText(/^Fixed meal, Dinner, Tue/)).toHaveValue(
      'none',
    );
  });
});

describe('the Brief step', () => {
  it('refuses a Brief over its limit', async () => {
    const user = userEvent.setup();
    render(<PlanWizardPage />);
    await finishDates(user);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.change(screen.getByLabelText('Brief'), {
      target: { value: 'x'.repeat(501) },
    });
    await user.click(screen.getByRole('button', { name: 'Plan my meals' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Keep the brief to 500 characters',
    );
    expect(proposeMock).not.toHaveBeenCalled();
  });
});

describe('asking for a proposal', () => {
  it.each([
    [
      domainError('MEAL_PLAN_RATE_LIMITED', { retryAfterSeconds: 600 }),
      'Try again in 10 minutes.',
    ],
    [domainError('MEAL_PLAN_TRY_AGAIN'), 'The plan didn’t work. Try again.'],
    [domainError('MEAL_PLAN_NOT_PROPOSED'), 'A plan couldn’t be made.'],
    [
      domainError('MEAL_PLAN_NO_RECIPES'),
      'There are no recipes to plan from yet.',
    ],
    [
      domainError('MEAL_PLAN_BATCH_TOO_SMALL'),
      'A batch cooks fewer portions than the people eating at its meal.',
    ],
  ])('shows an error plainly (%#)', async (error, message) => {
    const user = userEvent.setup();
    proposeMock.mockRejectedValueOnce(error);
    render(<PlanWizardPage />);
    await finishDates(user);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Plan my meals' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { name: /^Review/ }),
    ).toBeVisible();
  });

  it('shows progress while the call runs', async () => {
    const user = userEvent.setup();
    proposeMock.mockReturnValueOnce(new Promise(() => undefined));
    render(<PlanWizardPage />);
    await finishDates(user);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Plan my meals' }));
    expect(screen.getByRole('status')).toHaveTextContent(
      'Planning your meals…',
    );
  });
});

describe('Plan Review', () => {
  it('shows every slot badged with its reason, the summary, the figures and dropped slots', async () => {
    const user = userEvent.setup();
    render(<PlanWizardPage />);
    await toReview(user);

    expect(screen.getAllByText('AI suggestion').length).toBeGreaterThanOrEqual(
      4,
    );
    expect(screen.getByText('Why Lentil Soup')).toBeVisible();
    expect(screen.getByText('A light week.')).toBeVisible();
    expect(
      screen.getByText('1 meal couldn’t be suggested and was left empty.'),
    ).toBeVisible();
    expect(figuresQueryMock).toHaveBeenLastCalledWith(
      {
        dishes: [
          { date: MON, recipeId: 21, eaten: 2 },
          { date: MON, recipeId: 22, eaten: 2 },
          { date: TUE, recipeId: 23, eaten: 2 },
          { date: TUE, recipeId: 24, eaten: 2 },
        ],
      },
      expect.anything(),
    );
  });

  it('shows what’s left in the plan, and updates it after a discard', async () => {
    const user = userEvent.setup();
    const batch = suggestion(MON, LUNCH.id, 21, 'Lentil Soup');
    proposeMock.mockResolvedValueOnce({
      ...PROPOSAL,
      slots: [
        {
          ...batch,
          items: batch.items.map((item) => ({ ...item, prepared: 6 })),
        },
        suggestion(MON, DINNER.id, 22, 'Bean Chilli'),
        {
          ...suggestion(TUE, LUNCH.id, 21, 'Lentil Soup'),
          slotType: 'leftovers',
          leftoversSource: 'plan_meal',
          items: batch.items.map((item) => ({ ...item, prepared: 0 })),
        },
        suggestion(TUE, DINNER.id, 24, 'Fish Pie'),
      ],
    } satisfies ProposePlanResult);
    render(<PlanWizardPage />);
    await toReview(user);

    const left = screen.getByRole('list', { name: 'Left in plan' });
    expect(left).toHaveTextContent('Lentil Soup: 2 left in plan');

    await user.click(
      screen.getByRole('button', { name: /^Lunch on 2026-11-03/ }),
    );
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(
      await screen.findByRole('list', { name: 'Left in plan' }),
    ).toHaveTextContent('Lentil Soup: 4 left in plan');
  });

  it('shows a fixed variation’s base shortfall in review, and still applies', async () => {
    const user = userEvent.setup();
    recipesFetchMock.mockResolvedValue({
      items: [
        {
          id: 41,
          name: 'Tomato Pasta',
          imageUrl: null,
          isBase: false,
          baseRecipeId: 40,
          isDeleted: false,
        },
      ],
    });
    proposeMock.mockResolvedValueOnce({
      ...PROPOSAL,
      slots: [
        suggestion(MON, LUNCH.id, 21, 'Lentil Soup'),
        suggestion(TUE, LUNCH.id, 23, 'Green Salad'),
        suggestion(TUE, DINNER.id, 24, 'Fish Pie'),
      ],
    } satisfies ProposePlanResult);
    render(<PlanWizardPage />);
    await finishDates(user);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.selectOptions(
      screen.getByLabelText(/^Fixed meal, Dinner, Mon/),
      'recipe',
    );
    await user.type(screen.getByLabelText(/^Recipe, Dinner, Mon/), 'Pasta');
    await user.click(
      await screen.findByRole('option', { name: /Tomato Pasta/ }),
    );
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Plan my meals' }));
    await screen.findByRole('heading', { name: /^Review/ });

    const dinner = screen.getByRole('button', {
      name: /^Dinner on 2026-11-02/,
    });
    const slot = dinner.closest<HTMLElement>('[data-slot-id]');
    expect(slot).not.toBeNull();
    expect(
      within(slot ?? dinner).getByTestId('slot-item-shortfall'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
  });

  it('swaps, discards and restores, then applies what was kept', async () => {
    const user = userEvent.setup();
    render(<PlanWizardPage />);
    await toReview(user);

    await user.click(screen.getByRole('button', { name: /Lentil Soup/ }));
    await user.click(screen.getByRole('button', { name: 'Swap' }));
    await user.type(screen.getByLabelText('Swap for a recipe'), 'Roast');
    await user.click(
      await screen.findByRole('option', { name: /Sunday Roast/ }),
    );
    expect(await screen.findByText('Your pick')).toBeVisible();

    await user.click(screen.getByRole('button', { name: /Bean Chilli/ }));
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(await screen.findByText('Discarded')).toBeVisible();

    await user.click(screen.getByRole('button', { name: /Green Salad/ }));
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    const discarded = await screen.findAllByText('Discarded');
    expect(discarded).toHaveLength(2);
    await user.click(
      screen.getByRole('button', { name: /^Lunch on 2026-11-03/ }),
    );
    await user.click(
      screen.getByRole('button', { name: 'Restore suggestion' }),
    );
    expect(await screen.findByText('Why Green Salad')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Apply' }));

    const input = applyMock.mock.lastCall?.[0] as CreatePlanWithSlotsInput;
    expect(
      input.slots.map((slot) => [slot.slotType, slot.items[0]?.recipeId]),
    ).toEqual([
      ['recipe', 31],
      ['empty', undefined],
      ['recipe', 23],
      ['recipe', 24],
    ]);
    expect(input.reviewCounts).toEqual({
      suggested: 4,
      swapped: 1,
      discarded: 1,
      suggestedAgain: 0,
      anotherGo: 0,
    });
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/plans/$planId',
      params: { planId: '77' },
    });
  });

  it('runs another go with a note, keeping swapped and discarded slots', async () => {
    const user = userEvent.setup();
    render(<PlanWizardPage />);
    await toReview(user);
    await user.click(screen.getByRole('button', { name: /Bean Chilli/ }));
    await user.click(screen.getByRole('button', { name: 'Discard' }));

    proposeMock.mockResolvedValueOnce({
      slots: [
        suggestion(MON, LUNCH.id, 41, 'Pea Risotto'),
        suggestion(TUE, LUNCH.id, 43, 'Tomato Soup'),
        suggestion(TUE, DINNER.id, 44, 'Veg Curry'),
      ],
      summary: 'More veg.',
      dropped: 0,
    });
    await user.type(
      screen.getByRole('textbox', { name: 'Another go' }),
      'more veg',
    );
    await user.click(screen.getByRole('button', { name: 'Another go' }));

    const rerun = lastProposeInput();
    expect(rerun.note).toBe('more veg');
    expect(rerun.slots[1]?.fixed).toEqual({ kind: 'empty' });
    expect(rerun.previous).toEqual(PROPOSAL);
    expect(await screen.findByText('Pea Risotto')).toBeVisible();
    expect(screen.getByText('Discarded')).toBeVisible();
    expect(screen.getByText('More veg.')).toBeVisible();
  });

  it('keeps the proposal going back without changes, and asks before replacing it after a change', async () => {
    const user = userEvent.setup();
    render(<PlanWizardPage />);
    await toReview(user);
    await user.click(screen.getByRole('button', { name: /Bean Chilli/ }));
    await user.click(screen.getByRole('button', { name: 'Discard' }));

    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Back to review' }));
    expect(await screen.findByText('Discarded')).toBeVisible();
    expect(proposeMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.type(screen.getByLabelText('Brief'), 'light');
    await user.click(screen.getByRole('button', { name: 'Back to review' }));
    expect(
      await screen.findByRole('alertdialog', { name: 'Make a new plan?' }),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Make a new plan' }));
    expect(proposeMock).toHaveBeenCalledTimes(2);
    expect(lastProposeInput()).toMatchObject({
      brief: 'light',
      previous: null,
    });
    expect(await screen.findByText('Bean Chilli')).toBeVisible();
  });

  it.each([
    [
      domainError('PLAN_DATE_OVERLAP'),
      'That range overlaps an existing active or future plan.',
    ],
    [
      domainError('SLOT_RECIPE_NOT_PICKABLE', { recipeId: 21 }),
      'A recipe in this plan is no longer available.',
    ],
    [
      domainError('SLOT_DINER_NOT_FOUND'),
      'Someone eating in this plan is no longer in the household.',
    ],
    // A refusal with no domain code, such as a Zod one, whose message is JSON.
    [
      new TRPCClientError('[{"code":"custom","path":["slots",0]}]'),
      'The plan couldn’t be created. Try again.',
    ],
  ])(
    'keeps the review open and says plainly why Apply was refused (%#)',
    async (error, message) => {
      const user = userEvent.setup();
      applyMock.mockRejectedValueOnce(error);
      render(<PlanWizardPage />);
      await toReview(user);
      await user.click(screen.getByRole('button', { name: 'Apply' }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(message);
      expect(alert).not.toHaveTextContent('"code"');
      expect(screen.getByRole('heading', { name: /^Review/ })).toBeVisible();
      expect(navigateMock).not.toHaveBeenCalled();
    },
  );

  it('asks before leaving only while a proposal is on screen', async () => {
    const user = userEvent.setup();
    render(<PlanWizardPage />);
    const firstOptions = blockerMock.mock.lastCall?.[0] as {
      shouldBlockFn: () => boolean;
    };
    expect(firstOptions.shouldBlockFn()).toBe(false);
    await toReview(user);
    const options = blockerMock.mock.lastCall?.[0] as {
      shouldBlockFn: () => boolean;
    };
    expect(options.shouldBlockFn()).toBe(true);
    expect(applyMock).not.toHaveBeenCalled();
  });
});

describe('offline', () => {
  function setOnline(value: boolean): void {
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      get: () => value,
    });
    act(() => {
      window.dispatchEvent(new Event(value ? 'online' : 'offline'));
    });
  }

  afterEach(() => {
    setOnline(true);
  });

  it('can’t ask for a proposal while offline', async () => {
    const user = userEvent.setup();
    render(<PlanWizardPage />);
    await finishDates(user);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    setOnline(false);

    expect(
      screen.getByRole('button', { name: 'Plan my meals' }),
    ).toBeDisabled();
    expect(
      screen.getByText('You’re offline. Planning with AI needs a connection.'),
    ).toBeVisible();

    setOnline(true);
    expect(screen.getByRole('button', { name: 'Plan my meals' })).toBeEnabled();
  });

  it('can’t have another go or retry while offline', async () => {
    const user = userEvent.setup();
    render(<PlanWizardPage />);
    await toReview(user);
    setOnline(false);

    expect(screen.getByRole('button', { name: 'Another go' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
  });

  it('can’t try a failed proposal again while offline', async () => {
    const user = userEvent.setup();
    proposeMock.mockRejectedValueOnce(new Error('Failed to fetch'));
    render(<PlanWizardPage />);
    await finishDates(user);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Plan my meals' }));
    await screen.findByRole('button', { name: 'Try again' });
    setOnline(false);

    expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled();
  });
});
