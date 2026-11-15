import { describe, expect, it } from 'vitest';

import {
  cookedBefore,
  cutAtWord,
  normalisePlanProposal,
  normaliseSlotSuggestion,
  storageTakenExcept,
  type ProposalContext,
  type ProposalSlotContext,
  type SlotSuggestionContext,
} from '../src/lib/plan-proposal/normalise.ts';

const LUNCH = 1;
const DINNER = 2;

function slot(
  date: string,
  occasionId: number,
  overrides: Partial<ProposalSlotContext> = {},
): ProposalSlotContext {
  return {
    date,
    occasionId,
    occasion: occasionId === LUNCH ? 'Lunch' : 'Dinner',
    headcount: 2,
    fixed: null,
    ...overrides,
  };
}

function context(
  slots: ProposalSlotContext[],
  pickable: number[] = [10, 11, 12],
  storage: Partial<Pick<ProposalContext, 'held' | 'baseOf'>> = {},
): ProposalContext {
  return {
    slots,
    pickableRecipeIds: new Set(pickable),
    held: { dish: new Map(), base: new Map() },
    baseOf: new Map(),
    ...storage,
  };
}

function entry(
  date: string,
  occasion: string,
  recipeId: number,
  overrides: Partial<{
    kind: 'cook' | 'leftovers' | 'storage';
    prepared: number;
    useHeldBase: boolean;
    reason: string;
  }> = {},
) {
  return {
    date,
    occasion,
    kind: 'cook',
    recipeId,
    prepared: 2,
    useHeldBase: false,
    reason: 'A good fit.',
    ...overrides,
  };
}

describe('normalisePlanProposal', () => {
  it('gives each open slot one dish eaten by its headcount', () => {
    const proposal = normalisePlanProposal(
      {
        slots: [
          entry('2026-11-02', 'Lunch', 10, { prepared: 1 }),
          entry('2026-11-02', 'Dinner', 11, { prepared: 3 }),
        ],
        summary: 'A varied week.',
      },
      context([
        slot('2026-11-02', LUNCH, { headcount: 1 }),
        slot('2026-11-02', DINNER, { headcount: 3 }),
      ]),
    );
    expect(proposal).toEqual({
      slots: [
        {
          date: '2026-11-02',
          occasionId: LUNCH,
          slotType: 'recipe',
          leftoversSource: null,
          items: [{ recipeId: 10, prepared: 1, eaten: 1 }],
          reason: 'A good fit.',
        },
        {
          date: '2026-11-02',
          occasionId: DINNER,
          slotType: 'recipe',
          leftoversSource: null,
          items: [{ recipeId: 11, prepared: 3, eaten: 3 }],
          reason: 'A good fit.',
        },
      ],
      summary: 'A varied week.',
      dropped: 0,
    });
  });

  it('returns nothing for fixed slots, and ignores entries for them', () => {
    const proposal = normalisePlanProposal(
      {
        slots: [
          entry('2026-11-02', 'Lunch', 10),
          entry('2026-11-02', 'Dinner', 11),
          entry('2026-11-03', 'Dinner', 12),
        ],
        summary: '',
      },
      context([
        slot('2026-11-02', LUNCH),
        slot('2026-11-02', DINNER, { fixed: { kind: 'recipe', recipeId: 12 } }),
        slot('2026-11-03', DINNER, { fixed: { kind: 'eat_out' } }),
      ]),
    );
    expect(proposal?.slots).toHaveLength(1);
    expect(proposal?.slots[0]).toMatchObject({ occasionId: LUNCH });
    expect(proposal?.dropped).toBe(0);
  });

  it('leaves a slot nobody eats at empty, without counting it as dropped', () => {
    const proposal = normalisePlanProposal(
      {
        slots: [entry('2026-11-02', 'Dinner', 11)],
        summary: '',
      },
      context([
        slot('2026-11-02', LUNCH, { headcount: 0 }),
        slot('2026-11-02', DINNER),
      ]),
    );
    expect(proposal?.slots[0]).toEqual({
      date: '2026-11-02',
      occasionId: LUNCH,
      slotType: 'empty',
      leftoversSource: null,
      items: [],
      reason: null,
    });
    expect(proposal?.dropped).toBe(0);
  });

  it('empties and counts a slot with a recipe that isn’t pickable or in the household', () => {
    const proposal = normalisePlanProposal(
      {
        slots: [
          entry('2026-11-02', 'Lunch', 99),
          entry('2026-11-02', 'Dinner', 11),
        ],
        summary: '',
      },
      context([slot('2026-11-02', LUNCH), slot('2026-11-02', DINNER)]),
    );
    expect(proposal?.slots[0]).toMatchObject({ slotType: 'empty', items: [] });
    expect(proposal?.slots[1]).toMatchObject({ slotType: 'recipe' });
    expect(proposal?.dropped).toBe(1);
  });

  it('empties and counts a slot the model left out', () => {
    const proposal = normalisePlanProposal(
      { slots: [entry('2026-11-02', 'Dinner', 11)], summary: '' },
      context([slot('2026-11-02', LUNCH), slot('2026-11-02', DINNER)]),
    );
    expect(proposal?.slots[0]).toMatchObject({ slotType: 'empty' });
    expect(proposal?.dropped).toBe(1);
  });

  it('keeps the first entry for a slot named twice, matching occasions loosely', () => {
    const proposal = normalisePlanProposal(
      {
        slots: [
          entry('2026-11-02', ' lunch ', 10),
          entry('2026-11-02', 'Lunch', 11),
        ],
        summary: '',
      },
      context([slot('2026-11-02', LUNCH)]),
    );
    expect(proposal?.slots[0]?.items).toEqual([
      { recipeId: 10, prepared: 2, eaten: 2 },
    ]);
  });

  it('strips markdown from reasons and the summary', () => {
    const proposal = normalisePlanProposal(
      {
        slots: [
          entry('2026-11-02', 'Lunch', 10, {
            reason: '**Quick** and _light_.',
          }),
        ],
        summary: '# Week\n- Plenty of `veg`.',
      },
      context([slot('2026-11-02', LUNCH)]),
    );
    expect(proposal?.slots[0]?.reason).toBe('Quick and light.');
    expect(proposal?.summary).toBe('Week\nPlenty of veg.');
  });

  it('cuts a long reason and summary at a word, keeping the slot', () => {
    const reason = `${'word '.repeat(30)}end`;
    const summary = `${'plenty '.repeat(50)}end`;
    const proposal = normalisePlanProposal(
      { slots: [entry('2026-11-02', 'Lunch', 10, { reason })], summary },
      context([slot('2026-11-02', LUNCH)]),
    );
    expect(proposal?.slots[0]).toMatchObject({ slotType: 'recipe' });
    expect(proposal?.slots[0]?.reason).toBe(`${'word '.repeat(23)}word…`);
    expect(proposal?.summary).toBe(`${'plenty '.repeat(41)}plenty…`);
    expect(proposal?.dropped).toBe(0);
  });

  it('treats an empty reason as none', () => {
    const proposal = normalisePlanProposal(
      {
        slots: [entry('2026-11-02', 'Lunch', 10, { reason: '  ' })],
        summary: '',
      },
      context([slot('2026-11-02', LUNCH)]),
    );
    expect(proposal?.slots[0]).toMatchObject({
      slotType: 'recipe',
      reason: null,
    });
  });

  it.each([
    ['isn’t a candidate', { slots: 'none' }],
    ['is null', null],
    [
      'drops every slot that needed a dish',
      { slots: [entry('2026-11-02', 'Lunch', 99)], summary: '' },
    ],
  ])('refuses a reply that %s', (_label, candidate) => {
    expect(
      normalisePlanProposal(candidate, context([slot('2026-11-02', LUNCH)])),
    ).toBeNull();
  });

  it('never proposes eat out, takeaway, or takeaway or other leftovers', () => {
    const proposal = normalisePlanProposal(
      {
        slots: [
          entry('2026-11-02', 'Lunch', 10, { prepared: 4 }),
          entry('2026-11-02', 'Dinner', 10, { kind: 'leftovers' }),
          entry('2026-11-03', 'Lunch', 11, { prepared: 3 }),
        ],
        summary: '',
      },
      context([
        slot('2026-11-02', LUNCH),
        slot('2026-11-02', DINNER),
        slot('2026-11-03', LUNCH, { headcount: 0 }),
      ]),
    );
    for (const proposed of proposal?.slots ?? []) {
      expect(['recipe', 'leftovers', 'empty']).toContain(proposed.slotType);
      expect([null, 'plan_meal']).toContain(proposed.leftoversSource);
    }
  });

  describe('Batches', () => {
    it('keeps a dish that cooks more than its headcount, eating the headcount there', () => {
      const proposal = normalisePlanProposal(
        {
          slots: [entry('2026-11-02', 'Dinner', 10, { prepared: 6 })],
          summary: '',
        },
        context([slot('2026-11-02', DINNER)]),
      );
      expect(proposal?.slots[0]).toMatchObject({
        slotType: 'recipe',
        items: [{ recipeId: 10, prepared: 6, eaten: 2 }],
      });
      expect(proposal?.dropped).toBe(0);
    });

    it.each([
      ['cooks fewer portions than its headcount', 1],
      ['cooks more than the most a Batch may', 51],
      ['cooks part of a portion', 2.5],
    ])('empties and counts a dish that %s', (_label, prepared) => {
      const proposal = normalisePlanProposal(
        {
          slots: [
            entry('2026-11-02', 'Lunch', 10, { prepared }),
            entry('2026-11-02', 'Dinner', 11),
          ],
          summary: '',
        },
        context([slot('2026-11-02', LUNCH), slot('2026-11-02', DINNER)]),
      );
      expect(proposal?.slots[0]).toMatchObject({ slotType: 'empty' });
      expect(proposal?.dropped).toBe(1);
    });

    it('keeps a prepared-only Batch where nobody eats, on an otherwise empty slot', () => {
      const proposal = normalisePlanProposal(
        {
          slots: [
            entry('2026-11-01', 'Dinner', 10, {
              prepared: 8,
              reason: 'A Sunday cook-up.',
            }),
            entry('2026-11-02', 'Dinner', 11),
          ],
          summary: '',
        },
        context([
          slot('2026-11-01', DINNER, { headcount: 0 }),
          slot('2026-11-02', DINNER),
        ]),
      );
      expect(proposal?.slots[0]).toEqual({
        date: '2026-11-01',
        occasionId: DINNER,
        slotType: 'empty',
        leftoversSource: null,
        items: [{ recipeId: 10, prepared: 8, eaten: 0 }],
        reason: 'A Sunday cook-up.',
      });
      expect(proposal?.dropped).toBe(0);
    });

    it.each([
      ['a leftovers dish', { kind: 'leftovers' as const }],
      ['a Batch of no portions', { prepared: 0 }],
    ])(
      'ignores %s where nobody eats, leaving the slot empty and uncounted',
      (_label, overrides) => {
        const proposal = normalisePlanProposal(
          {
            slots: [
              entry('2026-11-01', 'Lunch', 10, { prepared: 4 }),
              entry('2026-11-01', 'Dinner', 10, overrides),
            ],
            summary: '',
          },
          context([
            slot('2026-11-01', LUNCH),
            slot('2026-11-01', DINNER, { headcount: 0 }),
          ]),
        );
        expect(proposal?.slots[1]).toMatchObject({
          slotType: 'empty',
          items: [],
        });
        expect(proposal?.dropped).toBe(0);
      },
    );
  });

  describe('leftovers', () => {
    it('keeps a plan-meal leftover of a dish cooked earlier, eating the headcount', () => {
      const proposal = normalisePlanProposal(
        {
          slots: [
            entry('2026-11-02', 'Lunch', 10, { kind: 'leftovers' }),
            entry('2026-11-01', 'Dinner', 10, { prepared: 4 }),
          ],
          summary: '',
        },
        context([
          slot('2026-11-02', LUNCH, { headcount: 3 }),
          slot('2026-11-01', DINNER),
        ]),
      );
      expect(proposal?.slots[0]).toMatchObject({
        slotType: 'leftovers',
        leftoversSource: 'plan_meal',
        items: [{ recipeId: 10, prepared: 0, eaten: 3 }],
      });
      expect(proposal?.dropped).toBe(0);
    });

    it('keeps a leftover of a Batch cooked where nobody eats', () => {
      const proposal = normalisePlanProposal(
        {
          slots: [
            entry('2026-11-01', 'Dinner', 10, { prepared: 6 }),
            entry('2026-11-02', 'Dinner', 10, { kind: 'leftovers' }),
          ],
          summary: '',
        },
        context([
          slot('2026-11-01', DINNER, { headcount: 0 }),
          slot('2026-11-02', DINNER),
        ]),
      );
      expect(proposal?.slots[1]).toMatchObject({ slotType: 'leftovers' });
    });

    it.each([
      [
        'a Batch Fixed meal',
        { kind: 'batch' as const, recipeId: 10, portions: 6 },
      ],
      ['a fixed recipe', { kind: 'recipe' as const, recipeId: 10 }],
    ])('keeps a leftover of %s earlier in the plan', (_label, fixed) => {
      const proposal = normalisePlanProposal(
        {
          slots: [entry('2026-11-02', 'Dinner', 10, { kind: 'leftovers' })],
          summary: '',
        },
        context([
          slot('2026-11-01', DINNER, { fixed }),
          slot('2026-11-02', DINNER),
        ]),
      );
      expect(proposal?.slots).toHaveLength(1);
      expect(proposal?.slots[0]).toMatchObject({ slotType: 'leftovers' });
    });

    it('drops a leftover whose dish is cooked only later, or at the same slot', () => {
      const proposal = normalisePlanProposal(
        {
          slots: [
            entry('2026-11-02', 'Lunch', 10, { kind: 'leftovers' }),
            entry('2026-11-02', 'Dinner', 10, { prepared: 4 }),
            entry('2026-11-03', 'Dinner', 11, { kind: 'leftovers' }),
          ],
          summary: '',
        },
        context([
          slot('2026-11-02', LUNCH),
          slot('2026-11-02', DINNER),
          slot('2026-11-03', DINNER),
        ]),
      );
      expect(proposal?.slots.map((s) => s.slotType)).toEqual([
        'empty',
        'recipe',
        'empty',
      ]);
      expect(proposal?.dropped).toBe(2);
    });

    it('drops a leftover whose earlier dish was itself dropped', () => {
      const proposal = normalisePlanProposal(
        {
          slots: [
            entry('2026-11-01', 'Dinner', 10, { prepared: 1 }),
            entry('2026-11-02', 'Dinner', 10, { kind: 'leftovers' }),
            entry('2026-11-03', 'Dinner', 11),
          ],
          summary: '',
        },
        context([
          slot('2026-11-01', DINNER),
          slot('2026-11-02', DINNER),
          slot('2026-11-03', DINNER),
        ]),
      );
      expect(proposal?.slots.map((s) => s.slotType)).toEqual([
        'empty',
        'empty',
        'recipe',
      ]);
      expect(proposal?.dropped).toBe(2);
    });

    it('drops a leftover of a recipe that isn’t pickable', () => {
      const proposal = normalisePlanProposal(
        {
          slots: [
            entry('2026-11-02', 'Dinner', 99, { kind: 'leftovers' }),
            entry('2026-11-03', 'Dinner', 11),
          ],
          summary: '',
        },
        context([
          slot('2026-11-01', DINNER, {
            fixed: { kind: 'batch', recipeId: 99, portions: 6 },
          }),
          slot('2026-11-02', DINNER),
          slot('2026-11-03', DINNER),
        ]),
      );
      expect(proposal?.slots[0]).toMatchObject({ slotType: 'empty' });
    });
  });

  it('keeps a serving variation whose base isn’t cooked earlier, leaving the shortfall to review', () => {
    // 12 is a variation; whether its base was cooked is a balance, not a rule.
    const proposal = normalisePlanProposal(
      { slots: [entry('2026-11-02', 'Dinner', 12)], summary: '' },
      context([slot('2026-11-02', DINNER)]),
    );
    expect(proposal?.slots[0]).toMatchObject({
      slotType: 'recipe',
      items: [{ recipeId: 12, prepared: 2, eaten: 2 }],
    });
  });
});

describe('normaliseSlotSuggestion', () => {
  const target = slot('2026-11-03', DINNER);

  function slotContext(
    overrides: Partial<SlotSuggestionContext> = {},
  ): SlotSuggestionContext {
    return {
      slot: target,
      cookedEarlier: new Set(),
      pickableRecipeIds: new Set([10, 11, 12]),
      avoidRecipeIds: new Set(),
      held: { dish: new Map(), base: new Map() },
      baseOf: new Map(),
      taken: new Map(),
      ...overrides,
    };
  }

  function dish(
    recipeId: number,
    overrides: Partial<{
      kind: 'cook' | 'leftovers' | 'storage';
      prepared: number;
      useHeldBase: boolean;
      reason: string;
    }> = {},
  ) {
    return {
      dish: {
        kind: 'cook',
        recipeId,
        prepared: 2,
        useHeldBase: false,
        reason: 'Something **fresh**.',
        ...overrides,
      },
    };
  }

  it('gives the slot one dish eaten by its headcount, with a plain-text reason', () => {
    expect(normaliseSlotSuggestion(dish(11), slotContext())).toEqual({
      date: '2026-11-03',
      occasionId: DINNER,
      slotType: 'recipe',
      leftoversSource: null,
      items: [{ recipeId: 11, prepared: 2, eaten: 2 }],
      reason: 'Something fresh.',
    });
  });

  it('keeps a Batch that cooks more than the headcount', () => {
    expect(
      normaliseSlotSuggestion(dish(11, { prepared: 6 }), slotContext())?.items,
    ).toEqual([{ recipeId: 11, prepared: 6, eaten: 2 }]);
  });

  it('tries again for a reply that isn’t a candidate, or a recipe that isn’t pickable', () => {
    expect(normaliseSlotSuggestion({ dish: 'x' }, slotContext())).toBeNull();
    expect(normaliseSlotSuggestion(dish(99), slotContext())).toBeNull();
  });

  it('tries again for a dish that cooks fewer than the headcount', () => {
    expect(
      normaliseSlotSuggestion(dish(11, { prepared: 1 }), slotContext()),
    ).toBeNull();
  });

  describe('repeats', () => {
    it('refuses a recipe already suggested while another is pickable', () => {
      expect(
        normaliseSlotSuggestion(
          dish(10),
          slotContext({ avoidRecipeIds: new Set([10, 11]) }),
        ),
      ).toBeNull();
    });

    it('allows a repeat when every pickable recipe was suggested', () => {
      expect(
        normaliseSlotSuggestion(
          dish(10),
          slotContext({ avoidRecipeIds: new Set([10, 11, 12]) }),
        )?.items,
      ).toEqual([{ recipeId: 10, prepared: 2, eaten: 2 }]);
    });
  });

  describe('leftovers', () => {
    it('keeps a plan-meal leftover of a dish cooked earlier', () => {
      expect(
        normaliseSlotSuggestion(
          dish(12, { kind: 'leftovers', prepared: 0 }),
          slotContext({ cookedEarlier: new Set([12]) }),
        ),
      ).toMatchObject({
        slotType: 'leftovers',
        leftoversSource: 'plan_meal',
        items: [{ recipeId: 12, prepared: 0, eaten: 2 }],
      });
    });

    it('tries again for a leftover of a dish not cooked earlier', () => {
      expect(
        normaliseSlotSuggestion(
          dish(12, { kind: 'leftovers', prepared: 0 }),
          slotContext(),
        ),
      ).toBeNull();
    });
  });

  describe('where nobody eats', () => {
    const nobody = slot('2026-11-03', DINNER, { headcount: 0 });

    it('keeps a prepared-only Batch on an empty slot', () => {
      expect(
        normaliseSlotSuggestion(
          dish(11, { prepared: 4 }),
          slotContext({ slot: nobody }),
        ),
      ).toMatchObject({
        slotType: 'empty',
        items: [{ recipeId: 11, prepared: 4, eaten: 0 }],
      });
    });

    it('leaves the slot empty when the planner gives no dish', () => {
      expect(
        normaliseSlotSuggestion({ dish: null }, slotContext({ slot: nobody })),
      ).toEqual({
        date: '2026-11-03',
        occasionId: DINNER,
        slotType: 'empty',
        leftoversSource: null,
        items: [],
        reason: null,
      });
    });

    it('tries again for a leftover there', () => {
      expect(
        normaliseSlotSuggestion(
          dish(12, { kind: 'leftovers', prepared: 0 }),
          slotContext({ slot: nobody, cookedEarlier: new Set([12]) }),
        ),
      ).toBeNull();
    });
  });

  it('tries again when no dish comes back where people eat', () => {
    expect(normaliseSlotSuggestion({ dish: null }, slotContext())).toBeNull();
  });
});

describe('cookedBefore', () => {
  it('collects what Fixed meals and the review cook at strictly earlier slots', () => {
    const slots = [
      slot('2026-11-02', LUNCH, { fixed: { kind: 'recipe', recipeId: 10 } }),
      slot('2026-11-02', DINNER),
      slot('2026-11-03', LUNCH, {
        headcount: 0,
        fixed: { kind: 'batch', recipeId: 13, portions: 4 },
      }),
      slot('2026-11-03', DINNER),
      slot('2026-11-04', LUNCH),
    ];
    const item = (recipeId: number, prepared: number) => ({
      recipeId,
      prepared,
      eaten: 2,
    });
    const cooked = cookedBefore(
      { date: '2026-11-03', occasion: 'Dinner' },
      slots,
      [
        { date: '2026-11-02', occasionId: DINNER, items: [item(11, 2)] },
        // A slot that isn't in the plan is ignored.
        { date: '2026-11-02', occasionId: DINNER + 10, items: [item(15, 2)] },
        // A fixed slot's entry is ignored.
        { date: '2026-11-02', occasionId: LUNCH, items: [item(16, 2)] },
        // The target and later slots don't count.
        { date: '2026-11-03', occasionId: DINNER, items: [item(12, 2)] },
        { date: '2026-11-04', occasionId: LUNCH, items: [item(14, 2)] },
      ],
    );
    expect([...cooked].sort()).toEqual([10, 11, 13]);
  });

  it('ignores a leftover’s portions, which aren’t cooked', () => {
    const slots = [slot('2026-11-02', DINNER), slot('2026-11-03', DINNER)];
    const cooked = cookedBefore(
      { date: '2026-11-03', occasion: 'Dinner' },
      slots,
      [
        {
          date: '2026-11-02',
          occasionId: DINNER,
          items: [{ recipeId: 11, prepared: 0, eaten: 2 }],
        },
      ],
    );
    expect(cooked.size).toBe(0);
  });
});

describe('storage in a Plan Proposal', () => {
  const LASAGNE = 30;
  const STEW_BASE = 31;
  const STEW_PIE = 32;
  const held = {
    dish: new Map([
      [LASAGNE, 2],
      [STEW_BASE, 2],
    ]),
    base: new Map([[STEW_BASE, 2]]),
  };
  const baseOf = new Map<number, number | null>([
    [10, null],
    [STEW_PIE, STEW_BASE],
  ]);
  const storageContext = (slots: ProposalSlotContext[]) =>
    context(slots, [10, STEW_PIE], { held, baseOf });

  it('keeps a Leftovers from Storage slot eating a held dish', () => {
    const proposal = normalisePlanProposal(
      {
        slots: [
          entry('2026-11-02', 'Dinner', LASAGNE, {
            kind: 'storage',
            prepared: 0,
          }),
        ],
        summary: 'Uses the lasagne.',
      },
      storageContext([slot('2026-11-02', DINNER)]),
    );
    expect(proposal?.slots[0]).toMatchObject({
      slotType: 'leftovers',
      leftoversSource: 'storage',
      items: [{ recipeId: LASAGNE, prepared: 0, eaten: 2, fromStorage: 2 }],
    });
  });

  it('accepts a held dish whose recipe isn’t pickable', () => {
    const proposal = normalisePlanProposal(
      {
        slots: [
          entry('2026-11-02', 'Dinner', LASAGNE, { kind: 'storage' }),
          entry('2026-11-03', 'Dinner', 99, { kind: 'storage' }),
        ],
        summary: 'Uses the lasagne.',
      },
      storageContext([slot('2026-11-02', DINNER), slot('2026-11-03', DINNER)]),
    );
    expect(proposal?.slots[0]?.leftoversSource).toBe('storage');
    expect(proposal?.slots[1]?.slotType).toBe('empty');
    expect(proposal?.dropped).toBe(1);
  });

  it('drops a storage slot when fewer portions are held than its headcount', () => {
    const proposal = normalisePlanProposal(
      {
        slots: [
          entry('2026-11-02', 'Lunch', 10),
          entry('2026-11-02', 'Dinner', LASAGNE, { kind: 'storage' }),
        ],
        summary: 'Uses the lasagne.',
      },
      storageContext([
        slot('2026-11-02', LUNCH),
        slot('2026-11-02', DINNER, { headcount: 3 }),
      ]),
    );
    expect(proposal?.slots[1]).toMatchObject({ slotType: 'empty' });
    expect(proposal?.dropped).toBe(1);
  });

  it('drops the second of two slots wanting the same held dish', () => {
    const proposal = normalisePlanProposal(
      {
        slots: [
          entry('2026-11-02', 'Dinner', LASAGNE, { kind: 'storage' }),
          entry('2026-11-03', 'Dinner', LASAGNE, { kind: 'storage' }),
        ],
        summary: 'Lasagne twice.',
      },
      storageContext([slot('2026-11-02', DINNER), slot('2026-11-03', DINNER)]),
    );
    expect(proposal?.slots.map((s) => s.slotType)).toEqual([
      'leftovers',
      'empty',
    ]);
    expect(proposal?.dropped).toBe(1);
  });

  it('never eats from storage where nobody eats', () => {
    const proposal = normalisePlanProposal(
      {
        slots: [
          entry('2026-11-02', 'Lunch', 10),
          entry('2026-11-02', 'Dinner', LASAGNE, { kind: 'storage' }),
        ],
        summary: 'A week.',
      },
      storageContext([
        slot('2026-11-02', LUNCH),
        slot('2026-11-02', DINNER, { headcount: 0 }),
      ]),
    );
    expect(proposal?.slots[1]).toMatchObject({ slotType: 'empty', items: [] });
    expect(proposal?.dropped).toBe(0);
  });

  it('cooks a Variation from its held base, taking its prepared portions', () => {
    const proposal = normalisePlanProposal(
      {
        slots: [entry('2026-11-02', 'Dinner', STEW_PIE, { useHeldBase: true })],
        summary: 'Pie from the stew.',
      },
      storageContext([slot('2026-11-02', DINNER)]),
    );
    expect(proposal?.slots[0]).toMatchObject({
      slotType: 'recipe',
      items: [{ recipeId: STEW_PIE, prepared: 2, eaten: 2, fromStorage: 2 }],
    });
  });

  it('drops a Variation whose held base is already taken by an earlier slot', () => {
    const proposal = normalisePlanProposal(
      {
        slots: [
          entry('2026-11-02', 'Dinner', STEW_BASE, { kind: 'storage' }),
          entry('2026-11-03', 'Dinner', STEW_PIE, { useHeldBase: true }),
        ],
        summary: 'Stew twice.',
      },
      context(
        [slot('2026-11-02', DINNER), slot('2026-11-03', DINNER)],
        [10, STEW_PIE],
        { held, baseOf },
      ),
    );
    expect(proposal?.slots.map((s) => s.slotType)).toEqual([
      'leftovers',
      'empty',
    ]);
  });

  it('ignores useHeldBase on a dish with no base', () => {
    const proposal = normalisePlanProposal(
      {
        slots: [entry('2026-11-02', 'Dinner', 10, { useHeldBase: true })],
        summary: 'A dish.',
      },
      storageContext([slot('2026-11-02', DINNER)]),
    );
    expect(proposal?.slots[0]?.items[0]).not.toHaveProperty('fromStorage');
  });

  it('counts what the review’s other slots take when suggesting again', () => {
    const target = slot('2026-11-03', DINNER);
    const taken = storageTakenExcept(
      target,
      [
        {
          date: '2026-11-02',
          occasionId: DINNER,
          slotType: 'leftovers',
          leftoversSource: 'storage',
          items: [{ recipeId: LASAGNE, prepared: 0, eaten: 2, fromStorage: 2 }],
        },
        {
          date: '2026-11-03',
          occasionId: DINNER,
          slotType: 'leftovers',
          leftoversSource: 'storage',
          items: [{ recipeId: LASAGNE, prepared: 0, eaten: 2, fromStorage: 2 }],
        },
      ],
      baseOf,
    );
    expect(taken.get(LASAGNE)).toBe(2);
    const suggestion = normaliseSlotSuggestion(
      {
        dish: {
          kind: 'storage',
          recipeId: LASAGNE,
          prepared: 0,
          useHeldBase: false,
          reason: 'The lasagne.',
        },
      },
      {
        slot: target,
        cookedEarlier: new Set(),
        pickableRecipeIds: new Set([10]),
        avoidRecipeIds: new Set(),
        held,
        baseOf,
        taken,
      },
    );
    expect(suggestion).toBeNull();
  });
});

describe('cutAtWord', () => {
  it('leaves text that fits', () => {
    expect(cutAtWord('Quick and light.', 16)).toBe('Quick and light.');
  });

  it('ends at the last whole word, with an ellipsis, within the limit', () => {
    expect(cutAtWord('Quick and light supper.', 12)).toBe('Quick and…');
  });

  it('keeps a word that ends exactly at the cut', () => {
    expect(cutAtWord('Quick and light supper.', 16)).toBe('Quick and light…');
  });

  it('cuts a single long word mid-word', () => {
    expect(cutAtWord('x'.repeat(10), 5)).toBe('xxxx…');
  });
});
