import type { ProposePlanResult, ProposedSlot } from '@loftys-larder/shared';
import { describe, expect, it } from 'vitest';

import {
  buildApplyInput,
  buildProposeInput,
  defaultAttendance,
  figuresInput,
  inputsSignature,
  pruneFixedMeals,
  rerunReview,
  resolveAttendance,
  reviewCounts,
  reviewPlanSlots,
  setReviewStatus,
  slotKey,
  startReview,
  wizardSlots,
  type RecipeChoice,
  type WizardInputs,
} from './plan-wizard.ts';

const LUNCH = { id: 1, name: 'Lunch' };
const DINNER = { id: 2, name: 'Dinner' };
const MON = '2026-11-02';
const TUE = '2026-11-03';

const ROAST: RecipeChoice = {
  id: 10,
  name: 'Sunday Roast',
  imageUrl: null,
  isBase: false,
  baseRecipeId: null,
};
const PASTA: RecipeChoice = {
  id: 11,
  name: 'Pasta',
  imageUrl: null,
  isBase: false,
  baseRecipeId: null,
};

function inputs(overrides: Partial<WizardInputs> = {}): WizardInputs {
  return {
    startDate: MON,
    endDate: TUE,
    occasions: [LUNCH, DINNER],
    attendance: defaultAttendance(['ann', 'bo']),
    fixed: new Map(),
    brief: '',
    ...overrides,
  };
}

function suggestion(
  date: string,
  occasionId: number,
  recipeId: number | null,
  reason = 'Because',
): ProposedSlot {
  return {
    date,
    occasionId,
    slotType: recipeId === null ? 'empty' : 'recipe',
    leftoversSource: null,
    items:
      recipeId === null
        ? []
        : [
            {
              recipeId,
              prepared: 2,
              eaten: 2,
              recipeName: `Recipe ${String(recipeId)}`,
              recipeImageUrl: null,
              isBase: false,
              baseRecipeId: null,
            },
          ],
    reason: recipeId === null ? null : reason,
  };
}

function proposal(
  slots: ProposedSlot[],
  summary = 'A week',
): ProposePlanResult {
  return { slots, summary, dropped: 0 };
}

describe('who’s eating', () => {
  it('starts as every household member and no guests at every slot', () => {
    const settings = defaultAttendance(['ann', 'bo']);
    for (const slot of wizardSlots(MON, TUE, [LUNCH, DINNER])) {
      expect(resolveAttendance(settings, slot.date, slot.occasionId)).toEqual({
        dinerUserIds: ['ann', 'bo'],
        guestCount: 0,
      });
    }
  });

  it('lets an occasion override every slot, and a slot override its occasion', () => {
    const settings = {
      all: { dinerUserIds: ['ann'], guestCount: 0 },
      byOccasion: new Map([
        [DINNER.id, { dinerUserIds: ['ann', 'bo'], guestCount: 0 }],
      ]),
      bySlot: new Map([
        [slotKey(TUE, DINNER.id), { dinerUserIds: ['bo'], guestCount: 1 }],
      ]),
    };
    expect(resolveAttendance(settings, MON, LUNCH.id).dinerUserIds).toEqual([
      'ann',
    ]);
    expect(resolveAttendance(settings, MON, DINNER.id).dinerUserIds).toEqual([
      'ann',
      'bo',
    ]);
    expect(resolveAttendance(settings, TUE, DINNER.id)).toEqual({
      dinerUserIds: ['bo'],
      guestCount: 1,
    });
  });

  it('drops a recipe Fixed meal where nobody eats any more', () => {
    const fixed = new Map([
      [slotKey(MON, LUNCH.id), { kind: 'recipe' as const, recipe: ROAST }],
      [slotKey(MON, DINNER.id), { kind: 'takeaway' as const }],
    ]);
    const attendance = {
      ...defaultAttendance(['ann']),
      bySlot: new Map([
        [slotKey(MON, LUNCH.id), { dinerUserIds: [], guestCount: 0 }],
        [slotKey(MON, DINNER.id), { dinerUserIds: [], guestCount: 0 }],
      ]),
    };
    const pruned = pruneFixedMeals(
      { attendance, fixed },
      wizardSlots(MON, TUE, [LUNCH, DINNER]),
    );
    expect([...pruned.keys()]).toEqual([slotKey(MON, DINNER.id)]);
  });

  it('drops Fixed meals outside the range, so they can’t come back unchecked', () => {
    const fixed = new Map([
      [slotKey(MON, DINNER.id), { kind: 'eat_out' as const }],
      [slotKey(TUE, DINNER.id), { kind: 'recipe' as const, recipe: ROAST }],
    ]);
    const pruned = pruneFixedMeals(
      { attendance: defaultAttendance(['ann']), fixed },
      wizardSlots(MON, MON, [LUNCH, DINNER]),
    );
    expect([...pruned.keys()]).toEqual([slotKey(MON, DINNER.id)]);
  });

  it('returns the same map when nothing is dropped', () => {
    const fixed = new Map([
      [slotKey(MON, DINNER.id), { kind: 'eat_out' as const }],
    ]);
    expect(
      pruneFixedMeals(
        { attendance: defaultAttendance(['ann']), fixed },
        wizardSlots(MON, TUE, [LUNCH, DINNER]),
      ),
    ).toBe(fixed);
  });
});

describe('asking for a proposal', () => {
  it('sends every slot’s attendance and Fixed meals, and the Brief', () => {
    const input = buildProposeInput(
      inputs({
        fixed: new Map([
          [slotKey(MON, LUNCH.id), { kind: 'recipe', recipe: ROAST }],
          [slotKey(MON, DINNER.id), { kind: 'eat_out' }],
        ]),
        brief: '  light  ',
      }),
      null,
    );
    expect(input.slots).toHaveLength(4);
    expect(input.slots[0]).toEqual({
      date: MON,
      occasionId: LUNCH.id,
      dinerUserIds: ['ann', 'bo'],
      guestCount: 0,
      fixed: { kind: 'recipe', recipeId: ROAST.id },
    });
    expect(input.slots[1]?.fixed).toEqual({ kind: 'eat_out' });
    expect(input.slots[2]?.fixed).toBeNull();
    expect(input).toMatchObject({ brief: 'light', note: null, previous: null });
  });

  it('on another go, sends swapped slots as Fixed recipes and discarded ones as fixed empty', () => {
    const first = proposal([
      suggestion(MON, LUNCH.id, 1),
      suggestion(MON, DINNER.id, 2),
      suggestion(TUE, LUNCH.id, 3),
      suggestion(TUE, DINNER.id, 4),
    ]);
    let review = startReview(first);
    review = setReviewStatus(review, slotKey(MON, LUNCH.id), {
      kind: 'swapped',
      recipe: PASTA,
    });
    review = setReviewStatus(review, slotKey(MON, DINNER.id), {
      kind: 'discarded',
    });

    const input = buildProposeInput(inputs(), { review, note: ' veggie ' });

    expect(input.slots.map((slot) => slot.fixed)).toEqual([
      { kind: 'recipe', recipeId: PASTA.id },
      { kind: 'empty' },
      null,
      null,
    ]);
    expect(input.note).toBe('veggie');
    expect(input.previous).toBe(first);
  });

  it('notices any change to the inputs a proposal was made from', () => {
    const base = inputs();
    const same = inputsSignature(inputs());
    expect(inputsSignature(base)).toBe(same);
    expect(inputsSignature(inputs({ brief: 'light' }))).not.toBe(same);
    expect(inputsSignature(inputs({ endDate: MON }))).not.toBe(same);
    expect(
      inputsSignature(
        inputs({
          fixed: new Map([[slotKey(MON, LUNCH.id), { kind: 'eat_out' }]]),
        }),
      ),
    ).not.toBe(same);
    expect(
      inputsSignature(
        inputs({
          attendance: {
            ...base.attendance,
            all: { dinerUserIds: ['ann'], guestCount: 1 },
          },
        }),
      ),
    ).not.toBe(same);
  });
});

describe('reviewing', () => {
  const first = proposal([
    suggestion(MON, DINNER.id, 1, 'Quick'),
    suggestion(TUE, LUNCH.id, 2),
    suggestion(TUE, DINNER.id, null),
  ]);
  const withFixed = inputs({
    fixed: new Map([
      [slotKey(MON, LUNCH.id), { kind: 'recipe', recipe: ROAST }],
    ]),
  });

  it('keeps every suggestion by default, with its reason, and shows Fixed meals as fixed', () => {
    const slots = reviewPlanSlots(withFixed, startReview(first));
    expect(
      slots.map((entry) => [entry.kind, entry.slot.items[0]?.recipeName]),
    ).toEqual([
      ['fixed', 'Sunday Roast'],
      ['suggested', 'Recipe 1'],
      ['suggested', 'Recipe 2'],
      ['unfilled', undefined],
    ]);
    expect(slots[1]?.reason).toBe('Quick');
    expect(slots[0]?.slot.items[0]).toMatchObject({ prepared: 2, eaten: 2 });
    expect(slots.map((entry) => entry.slot.dinerUserIds)).toEqual(
      Array.from({ length: 4 }, () => ['ann', 'bo']),
    );
    expect(slots[0]?.canSwap).toBe(false);
  });

  it('swaps, discards and restores a suggestion', () => {
    const key = slotKey(MON, DINNER.id);
    let review = startReview(first);
    review = setReviewStatus(review, key, { kind: 'swapped', recipe: PASTA });
    expect(reviewPlanSlots(withFixed, review)[1]).toMatchObject({
      kind: 'swapped',
      reason: null,
      slot: { slotType: 'recipe', items: [{ recipeName: 'Pasta', eaten: 2 }] },
    });
    review = setReviewStatus(review, key, { kind: 'discarded' });
    expect(reviewPlanSlots(withFixed, review)[1]).toMatchObject({
      kind: 'discarded',
      slot: { slotType: 'empty', items: [], dinerUserIds: ['ann', 'bo'] },
    });
    review = setReviewStatus(review, key, { kind: 'suggested' });
    expect(reviewPlanSlots(withFixed, review)[1]).toMatchObject({
      kind: 'suggested',
      reason: 'Quick',
      slot: { items: [{ recipeName: 'Recipe 1' }] },
    });
  });

  it('replaces only slots still as suggested on another go', () => {
    let review = startReview(first);
    review = setReviewStatus(review, slotKey(MON, DINNER.id), {
      kind: 'swapped',
      recipe: PASTA,
    });
    const next = rerunReview(
      review,
      proposal(
        [suggestion(TUE, LUNCH.id, 7), suggestion(TUE, DINNER.id, 8)],
        'Again',
      ),
    );
    const slots = reviewPlanSlots(withFixed, next);
    expect(slots.map((entry) => entry.slot.items[0]?.recipeName)).toEqual([
      'Sunday Roast',
      'Pasta',
      'Recipe 7',
      'Recipe 8',
    ]);
    expect(next.summary).toBe('Again');
    expect(next.anotherGoCount).toBe(1);
    // Restoring the swap brings back the suggestion it replaced.
    const restored = setReviewStatus(next, slotKey(MON, DINNER.id), {
      kind: 'suggested',
    });
    expect(
      reviewPlanSlots(withFixed, restored)[1]?.slot.items[0]?.recipeName,
    ).toBe('Recipe 1');
  });

  it('works out the figures’ input from the proposal as it stands', () => {
    const review = setReviewStatus(startReview(first), slotKey(TUE, LUNCH.id), {
      kind: 'discarded',
    });
    expect(figuresInput(reviewPlanSlots(withFixed, review))).toEqual({
      dishes: [
        { date: MON, recipeId: ROAST.id, eaten: 2 },
        { date: MON, recipeId: 1, eaten: 2 },
      ],
    });
  });
});

describe('applying', () => {
  it('sends every slot, the kept proposals and the review’s counts, but no reasons', () => {
    let review = startReview(
      proposal([
        suggestion(MON, DINNER.id, 1),
        suggestion(TUE, LUNCH.id, 2),
        suggestion(TUE, DINNER.id, 3),
      ]),
    );
    review = setReviewStatus(review, slotKey(TUE, LUNCH.id), {
      kind: 'swapped',
      recipe: PASTA,
    });
    review = setReviewStatus(review, slotKey(TUE, DINNER.id), {
      kind: 'discarded',
    });
    review = rerunReview(review, proposal([suggestion(MON, DINNER.id, 4)]));

    const input = buildApplyInput(
      inputs({
        fixed: new Map([[slotKey(MON, LUNCH.id), { kind: 'takeaway' }]]),
      }),
      review,
    );

    expect(input.slots).toEqual([
      {
        date: MON,
        occasionId: LUNCH.id,
        slotType: 'takeaway',
        leftoversSource: null,
        items: [],
        dinerUserIds: ['ann', 'bo'],
        guestCount: 0,
      },
      expect.objectContaining({
        slotType: 'recipe',
        items: [{ recipeId: 4, prepared: 2, eaten: 2, sortOrder: 0 }],
      }),
      expect.objectContaining({
        slotType: 'recipe',
        items: [{ recipeId: PASTA.id, prepared: 2, eaten: 2, sortOrder: 0 }],
      }),
      expect.objectContaining({
        slotType: 'empty',
        items: [],
        dinerUserIds: ['ann', 'bo'],
      }),
    ]);
    expect(JSON.stringify(input)).not.toContain('Because');
    expect(input.reviewCounts).toEqual({
      suggested: 3,
      swapped: 1,
      discarded: 1,
      suggestedAgain: 0,
      anotherGo: 1,
    });
    expect(reviewCounts(review)).toEqual(input.reviewCounts);
  });
});
