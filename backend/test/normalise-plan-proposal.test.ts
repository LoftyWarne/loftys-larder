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
  reason = 'A good fit.',
) {
  return { date, occasion, recipeId, reason };
}

describe('normalisePlanProposal', () => {
  it('gives each open slot one dish eaten by its headcount', () => {
    const proposal = normalisePlanProposal(
      {
        slots: [
          entry('2026-11-02', 'Lunch', 10),
          entry('2026-11-02', 'Dinner', 11),
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
        slots: [
          entry('2026-11-02', 'Lunch', 10),
          entry('2026-11-02', 'Dinner', 11),
        ],
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
        slots: [entry('2026-11-02', 'Lunch', 10, '**Quick** and _light_.')],
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
      { slots: [entry('2026-11-02', 'Lunch', 10, reason)], summary },
      context([slot('2026-11-02', LUNCH)]),
    );
    expect(proposal?.slots[0]).toMatchObject({ slotType: 'recipe' });
    expect(proposal?.slots[0]?.reason).toBe(`${'word '.repeat(23)}word…`);
    expect(proposal?.summary).toBe(`${'plenty '.repeat(41)}plenty…`);
    expect(proposal?.dropped).toBe(0);
  });

  it('treats an empty reason as none', () => {
    const proposal = normalisePlanProposal(
      { slots: [entry('2026-11-02', 'Lunch', 10, '  ')], summary: '' },
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

  it('never proposes eat out, takeaway or leftovers', () => {
    const proposal = normalisePlanProposal(
      {
        slots: [
          entry('2026-11-02', 'Lunch', 10),
          entry('2026-11-02', 'Dinner', 11),
        ],
        summary: '',
      },
      context([slot('2026-11-02', LUNCH), slot('2026-11-02', DINNER)]),
    );
    for (const proposed of proposal?.slots ?? []) {
      expect(['recipe', 'empty']).toContain(proposed.slotType);
      expect(proposed.leftoversSource).toBeNull();
    }
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
