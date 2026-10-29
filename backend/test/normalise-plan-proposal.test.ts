import { describe, expect, it } from 'vitest';

import {
  cutAtWord,
  normalisePlanProposal,
  type ProposalContext,
  type ProposalSlotContext,
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
): ProposalContext {
  return { slots, pickableRecipeIds: new Set(pickable) };
}

function entry(
  date: string,
  occasion: string,
  recipeId: number,
  overrides: Partial<{
    kind: 'cook' | 'leftovers';
    prepared: number;
    reason: string;
  }> = {},
) {
  return {
    date,
    occasion,
    kind: 'cook',
    recipeId,
    prepared: 2,
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
