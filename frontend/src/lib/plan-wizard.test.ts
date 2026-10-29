import type { ProposePlanResult, ProposedSlot } from '@loftys-larder/shared';
import { describe, expect, it } from 'vitest';

import { deriveBaseBalances } from './serving-variation-supply.ts';
import {
  applySlotSuggestion,
  batchPortionsError,
  buildApplyInput,
  buildProposeInput,
  buildProposeSlotInput,
  defaultAttendance,
  figuresInput,
  inputsSignature,
  invalidBatches,
  leftInPlan,
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

describe('suggesting again for one slot', () => {
  const first = proposal([
    suggestion(MON, DINNER.id, 1, 'Quick'),
    suggestion(TUE, LUNCH.id, 2),
    suggestion(TUE, DINNER.id, null),
  ]);
  const withFixed = inputs({
    fixed: new Map([
      [slotKey(MON, LUNCH.id), { kind: 'recipe', recipe: ROAST }],
    ]),
    brief: ' light ',
  });
  const key = slotKey(TUE, LUNCH.id);

  it('sends the wizard’s inputs, the review as it stands, the slot and what was suggested there', () => {
    const review = setReviewStatus(
      startReview(first),
      slotKey(MON, DINNER.id),
      { kind: 'swapped', recipe: PASTA },
    );
    const input = buildProposeSlotInput(withFixed, review, key);
    expect(input).toMatchObject({
      startDate: MON,
      endDate: TUE,
      brief: 'light',
      target: { date: TUE, occasionId: LUNCH.id },
      avoidRecipeIds: [2],
    });
    // The wizard's Fixed meals only: a swap isn't sent as fixed.
    expect(input.slots.map((slot) => slot.fixed)).toEqual([
      { kind: 'recipe', recipeId: ROAST.id },
      null,
      null,
      null,
    ]);
    expect(input.current).toEqual([
      {
        date: MON,
        occasionId: DINNER.id,
        slotType: 'recipe',
        leftoversSource: null,
        items: [{ recipeId: PASTA.id, prepared: 2, eaten: 2 }],
      },
      {
        date: TUE,
        occasionId: LUNCH.id,
        slotType: 'recipe',
        leftoversSource: null,
        items: [{ recipeId: 2, prepared: 2, eaten: 2 }],
      },
      {
        date: TUE,
        occasionId: DINNER.id,
        slotType: 'empty',
        leftoversSource: null,
        items: [],
      },
    ]);
  });

  it('replaces only that slot, with its new reason, and avoids every suggestion so far', () => {
    let review = applySlotSuggestion(
      startReview(first),
      key,
      suggestion(TUE, LUNCH.id, 5, 'Fresh'),
    );
    review = applySlotSuggestion(
      review,
      key,
      suggestion(TUE, LUNCH.id, 6, 'Fresher'),
    );
    const slots = reviewPlanSlots(withFixed, review);
    expect(slots.map((entry) => entry.slot.items[0]?.recipeName)).toEqual([
      'Sunday Roast',
      'Recipe 1',
      'Recipe 6',
      undefined,
    ]);
    expect(slots[2]).toMatchObject({
      kind: 'suggested',
      reason: 'Fresher',
      suggestedAgain: true,
    });
    expect(slots[1]?.suggestedAgain).toBe(false);
    expect(
      buildProposeSlotInput(withFixed, review, key).avoidRecipeIds,
    ).toEqual([2, 5, 6]);
  });

  it('works on a swapped or discarded slot, and restore then puts back the latest suggestion', () => {
    let review = setReviewStatus(startReview(first), key, {
      kind: 'swapped',
      recipe: PASTA,
    });
    review = applySlotSuggestion(review, key, suggestion(TUE, LUNCH.id, 5));
    expect(reviewPlanSlots(withFixed, review)[2]?.kind).toBe('suggested');

    review = setReviewStatus(review, key, { kind: 'discarded' });
    review = applySlotSuggestion(review, key, suggestion(TUE, LUNCH.id, 6));
    review = setReviewStatus(review, key, { kind: 'swapped', recipe: PASTA });
    review = setReviewStatus(review, key, { kind: 'suggested' });
    expect(reviewPlanSlots(withFixed, review)[2]?.slot.items[0]?.recipeId).toBe(
      6,
    );
  });

  it('sends the latest suggestion back on another go, and adds its suggestions to the history', () => {
    let review = applySlotSuggestion(
      startReview(first),
      key,
      suggestion(TUE, LUNCH.id, 5),
    );
    expect(
      buildProposeInput(withFixed, { review, note: '' }).previous?.slots[1]
        ?.items[0]?.recipeId,
    ).toBe(5);
    review = rerunReview(review, proposal([suggestion(TUE, LUNCH.id, 7)]));
    expect(
      buildProposeSlotInput(withFixed, review, key).avoidRecipeIds,
    ).toEqual([2, 5, 7]);
    // Still as suggested, so another go replaced it.
    expect(reviewPlanSlots(withFixed, review)[2]?.slot.items[0]?.recipeId).toBe(
      7,
    );
  });

  it('offers Suggest again on every slot that isn’t fixed, even where nobody eats', () => {
    const nobodyAtTueDinner = inputs({
      ...withFixed,
      attendance: {
        ...defaultAttendance(['ann', 'bo']),
        bySlot: new Map([
          [slotKey(TUE, DINNER.id), { dinerUserIds: [], guestCount: 0 }],
        ]),
      },
    });
    const slots = reviewPlanSlots(nobodyAtTueDinner, startReview(first));
    expect(slots.map((entry) => entry.canSuggestAgain)).toEqual([
      false,
      true,
      true,
      true,
    ]);
    expect(slots[3]?.canSwap).toBe(false);
  });

  it('counts each slot suggested again once', () => {
    let review = applySlotSuggestion(
      startReview(first),
      key,
      suggestion(TUE, LUNCH.id, 5),
    );
    review = applySlotSuggestion(review, key, suggestion(TUE, LUNCH.id, 6));
    review = applySlotSuggestion(
      review,
      slotKey(MON, DINNER.id),
      suggestion(MON, DINNER.id, 7),
    );
    review = setReviewStatus(review, key, { kind: 'discarded' });
    expect(reviewCounts(review)).toMatchObject({
      suggestedAgain: 2,
      discarded: 1,
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

describe('batch cooking', () => {
  const KEEMA: RecipeChoice = {
    id: 20,
    name: 'Keema',
    imageUrl: null,
    isBase: false,
    baseRecipeId: null,
  };
  const WED = '2026-11-04';
  const nobodyAtMonLunch = {
    ...defaultAttendance(['ann', 'bo']),
    bySlot: new Map([
      [slotKey(MON, LUNCH.id), { dinerUserIds: [], guestCount: 0 }],
    ]),
  };

  function batchAt(
    key: string,
    portions: number,
  ): Map<string, { kind: 'batch'; recipe: RecipeChoice; portions: number }> {
    return new Map([[key, { kind: 'batch', recipe: KEEMA, portions }]]);
  }

  function leftovers(
    date: string,
    occasionId: number,
    recipe: RecipeChoice,
  ): ProposedSlot {
    return {
      date,
      occasionId,
      slotType: 'leftovers',
      leftoversSource: 'plan_meal',
      items: [
        {
          recipeId: recipe.id,
          prepared: 0,
          eaten: 2,
          recipeName: recipe.name,
          recipeImageUrl: null,
          isBase: recipe.isBase,
          baseRecipeId: recipe.baseRecipeId,
        },
      ],
      reason: 'Easy night.',
    };
  }

  it('has the people eating at a Batch Fixed meal eat it there', () => {
    const slots = reviewPlanSlots(
      inputs({ fixed: batchAt(slotKey(MON, DINNER.id), 6) }),
      startReview(proposal([])),
    );
    expect(slots[1]).toMatchObject({
      kind: 'fixed',
      slot: {
        slotType: 'recipe',
        items: [{ recipeName: 'Keema', prepared: 6, eaten: 2 }],
      },
    });
  });

  it('makes a Batch Fixed meal where nobody eats prepared-only', () => {
    const slots = reviewPlanSlots(
      inputs({
        attendance: nobodyAtMonLunch,
        fixed: batchAt(slotKey(MON, LUNCH.id), 4),
      }),
      startReview(proposal([])),
    );
    expect(slots[0]).toMatchObject({
      kind: 'fixed',
      slot: {
        slotType: 'empty',
        items: [{ recipeName: 'Keema', prepared: 4, eaten: 0 }],
      },
    });
  });

  it('refuses a Batch with fewer portions than its slot’s headcount', () => {
    const two = { dinerUserIds: ['ann', 'bo'], guestCount: 0 };
    expect(batchPortionsError(1, two)).toBe(
      'Cook at least 2 portions: everyone eating here eats it.',
    );
    expect(batchPortionsError(Number.NaN, two)).not.toBeNull();
    expect(batchPortionsError(2.5, two)).not.toBeNull();
    expect(batchPortionsError(51, two)).toBe('Cook at most 50 portions.');
    expect(batchPortionsError(2, two)).toBeNull();
    expect(batchPortionsError(0, { dinerUserIds: [], guestCount: 0 })).toBe(
      'Cook at least 1 portion.',
    );
    expect(
      invalidBatches(
        {
          attendance: defaultAttendance(['ann', 'bo']),
          fixed: batchAt(slotKey(MON, DINNER.id), 1),
        },
        wizardSlots(MON, TUE, [LUNCH, DINNER]),
      ),
    ).toEqual([slotKey(MON, DINNER.id)]);
  });

  it('keeps a Batch Fixed meal that no longer feeds its slot, flagged for step 3', () => {
    const attendance = {
      ...defaultAttendance(['ann', 'bo']),
      byOccasion: new Map([
        [DINNER.id, { dinerUserIds: ['ann', 'bo'], guestCount: 2 }],
      ]),
    };
    const fixed = new Map([
      ...batchAt(slotKey(MON, DINNER.id), 3),
      ...batchAt(slotKey(TUE, DINNER.id), 4),
    ]);
    const slots = wizardSlots(MON, TUE, [LUNCH, DINNER]);
    const pruned = pruneFixedMeals({ attendance, fixed }, slots);
    expect(pruned).toBe(fixed);
    expect(invalidBatches({ attendance, fixed: pruned }, slots)).toEqual([
      slotKey(MON, DINNER.id),
    ]);
  });

  it('sends a Batch Fixed meal with its portions', () => {
    const input = buildProposeInput(
      inputs({ fixed: batchAt(slotKey(MON, DINNER.id), 6) }),
      null,
    );
    expect(input.slots[1]?.fixed).toEqual({
      kind: 'batch',
      recipeId: KEEMA.id,
      portions: 6,
    });
  });

  // Manual verification step 1, over a three-day plan.
  describe('balances over a proposal', () => {
    const batchInputs = inputs({
      endDate: WED,
      fixed: batchAt(slotKey(MON, DINNER.id), 6),
    });
    const first = proposal([
      suggestion(MON, LUNCH.id, 1),
      leftovers(TUE, LUNCH.id, KEEMA),
      suggestion(TUE, DINNER.id, 2),
      suggestion(WED, LUNCH.id, 3),
      leftovers(WED, DINNER.id, KEEMA),
    ]);

    function balances(review: ReturnType<typeof startReview>) {
      const slots = reviewPlanSlots(batchInputs, review).map(
        (entry) => entry.slot,
      );
      const derived = deriveBaseBalances(slots);
      return {
        short: [...derived.shortfallBySlot.values()],
        left: leftInPlan(slots, derived.remainingByBase),
      };
    }

    it('shows nothing short and nothing left when the Batch is eaten up', () => {
      expect(balances(startReview(first))).toEqual({ short: [], left: [] });
    });

    it('shows what’s left after a discard, and clears it on restore', () => {
      const key = slotKey(WED, DINNER.id);
      const discarded = setReviewStatus(startReview(first), key, {
        kind: 'discarded',
      });
      expect(balances(discarded).left).toEqual([
        { recipeId: KEEMA.id, recipeName: 'Keema', portions: 2 },
      ]);
      const restored = setReviewStatus(discarded, key, { kind: 'suggested' });
      expect(balances(restored)).toEqual({ short: [], left: [] });
    });

    it('shows what’s left after a swap', () => {
      const swapped = setReviewStatus(
        startReview(first),
        slotKey(TUE, LUNCH.id),
        { kind: 'swapped', recipe: PASTA },
      );
      expect(balances(swapped).left).toEqual([
        { recipeId: KEEMA.id, recipeName: 'Keema', portions: 2 },
      ]);
    });

    it('shows a shortfall when leftovers outrun the Batch', () => {
      const small = inputs({
        endDate: WED,
        fixed: batchAt(slotKey(MON, DINNER.id), 4),
      });
      const slots = reviewPlanSlots(small, startReview(first)).map(
        (entry) => entry.slot,
      );
      expect([...deriveBaseBalances(slots).shortfallBySlot.values()]).toEqual([
        2,
      ]);
    });

    it('applies the Batch and its leftovers as the planner writes them', () => {
      const input = buildApplyInput(batchInputs, startReview(first));
      expect(
        input.slots.map((slot) => [
          slot.slotType,
          slot.leftoversSource,
          slot.items.map((item) => [item.recipeId, item.prepared, item.eaten]),
        ]),
      ).toEqual([
        ['recipe', null, [[1, 2, 2]]],
        ['recipe', null, [[KEEMA.id, 6, 2]]],
        ['leftovers', 'plan_meal', [[KEEMA.id, 0, 2]]],
        ['recipe', null, [[2, 2, 2]]],
        ['recipe', null, [[3, 2, 2]]],
        ['leftovers', 'plan_meal', [[KEEMA.id, 0, 2]]],
      ]);
    });
  });

  it('applies a prepared-only Batch on an otherwise empty slot', () => {
    const input = buildApplyInput(
      inputs({
        attendance: nobodyAtMonLunch,
        fixed: batchAt(slotKey(MON, LUNCH.id), 4),
      }),
      startReview(proposal([])),
    );
    expect(input.slots[0]).toMatchObject({
      slotType: 'empty',
      items: [{ recipeId: KEEMA.id, prepared: 4, eaten: 0, sortOrder: 0 }],
      dinerUserIds: [],
    });
  });
});
