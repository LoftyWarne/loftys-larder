import { describe, expect, it } from 'vitest';

import { highlightStep, type StepHighlightContext } from './step-highlights.ts';

const NO_CONTEXT: StepHighlightContext = { ingredientNames: [], unitNames: [] };

function bolded(text: string, context = NO_CONTEXT): string[] {
  return highlightStep(text, context)
    .filter((segment) => segment.bold)
    .map((segment) => segment.text);
}

describe('highlightStep', () => {
  it('returns the whole text as one plain segment when nothing matches', () => {
    expect(highlightStep('Stir well.', NO_CONTEXT)).toEqual([
      { text: 'Stir well.', bold: false },
    ]);
  });

  it('returns no segments for empty text', () => {
    expect(highlightStep('', NO_CONTEXT)).toEqual([]);
  });

  it('keeps the full text when joined back together', () => {
    const text = 'Roast at 200°C for 20 mins, then add 2 tbsp butter.';
    const context = { ingredientNames: ['Butter'], unitNames: [] };
    expect(
      highlightStep(text, context)
        .map((segment) => segment.text)
        .join(''),
    ).toBe(text);
  });

  it.each([
    ['Simmer for 20 min.', '20 min'],
    ['Simmer for 20 mins.', '20 mins'],
    ['Simmer for 20minutes.', '20minutes'],
    ['Rest for 1 minute.', '1 minute'],
    ['Wait 30 seconds.', '30 seconds'],
    ['Wait 30 secs.', '30 secs'],
    ['Braise for 2 hours.', '2 hours'],
    ['Braise for 1 hr.', '1 hr'],
    ['Braise for 2 hrs.', '2 hrs'],
    ['Braise for 1½ hours.', '1½ hours'],
    ['Braise for 1.5 hours.', '1.5 hours'],
    ['Cook for 1-2 hours.', '1-2 hours'],
    ['Cook for 1–2 hours.', '1–2 hours'],
    ['Cook for 10 to 15 minutes.', '10 to 15 minutes'],
  ])('bolds the time in %j', (text, expected) => {
    expect(bolded(text)).toEqual([expected]);
  });

  it.each([
    ['Heat the oven to 200°C.', '200°C'],
    ['Heat the oven to 180 °C.', '180 °C'],
    ['Heat the oven to 200C.', '200C'],
    ['Heat the oven to 400°F.', '400°F'],
    ['Heat the oven to 180°C fan.', '180°C fan'],
    ['Heat the oven to 180°.', '180°'],
    ['Heat the oven to gas mark 4.', 'gas mark 4'],
    ['Heat the oven to Gas Mark 6.', 'Gas Mark 6'],
  ])('bolds the temperature in %j', (text, expected) => {
    expect(bolded(text)).toEqual([expected]);
  });

  it.each([
    ['Add 300g of it.', '300g'],
    ['Add 1 kg of it.', '1 kg'],
    ['Add 250ml of it.', '250ml'],
    ['Add 1 l of it.', '1 l'],
    ['Add 2 tsp of it.', '2 tsp'],
    ['Add 2 Tbsp of it.', '2 Tbsp'],
    ['Add 2 cups of it.', '2 cups'],
    ['Add 2 pinches of it.', '2 pinches'],
    ['Add ½ tsp of it.', '½ tsp'],
    ['Add 1/2 tsp of it.', '1/2 tsp'],
    ['Add 2-3 tbsp of it.', '2-3 tbsp'],
  ])('bolds the quantity in %j', (text, expected) => {
    expect(bolded(text)).toEqual([expected]);
  });

  it('bolds quantities in units the recipe uses', () => {
    const context = { ingredientNames: [], unitNames: ['piece', 'clove'] };
    expect(bolded('Add 2 pieces and 3 cloves.', context)).toEqual([
      '2 pieces',
      '3 cloves',
    ]);
  });

  describe('ingredient names', () => {
    it('matches case-insensitively as whole words', () => {
      const context = { ingredientNames: ['Onion'], unitNames: [] };
      expect(bolded('Fry the onion. Onion again.', context)).toEqual([
        'onion',
        'Onion',
      ]);
    });

    it('matches simple plurals', () => {
      const context = { ingredientNames: ['Onion', 'Potato'], unitNames: [] };
      expect(bolded('Fry the onions and potatoes.', context)).toEqual([
        'onions',
        'potatoes',
      ]);
    });

    it('prefers the longest name when names overlap', () => {
      const context = { ingredientNames: ['Oil', 'Olive Oil'], unitNames: [] };
      expect(bolded('Warm the olive oil.', context)).toEqual(['olive oil']);
    });

    it('ignores the bracketed part of a name', () => {
      const context = { ingredientNames: ['Tomatoes (tinned)'], unitNames: [] };
      expect(bolded('Pour in the tomatoes.', context)).toEqual(['tomatoes']);
    });

    it('does not match inside a longer word', () => {
      const context = { ingredientNames: ['Salt', 'Pea'], unitNames: [] };
      expect(bolded('Boil salted water and peanuts.', context)).toEqual([]);
    });

    it('does not match a shortened form of a multi-word name', () => {
      const context = { ingredientNames: ['Olive Oil'], unitNames: [] };
      expect(bolded('Warm the oil.', context)).toEqual([]);
    });

    it('treats regex characters in names literally', () => {
      const context = { ingredientNames: ['Salt+'], unitNames: [] };
      expect(bolded('Add salt+ and saltt.', context)).toEqual(['salt+']);
    });
  });

  it('bolds a quantity and its ingredient as separate segments', () => {
    const context = { ingredientNames: ['Flour'], unitNames: [] };
    expect(bolded('Sift 300g flour.', context)).toEqual(['300g', 'flour']);
  });

  it.each([
    'Cut into 4.',
    'Repeat step 2.',
    'Serves 4 people.',
    'Add 2 large onions.',
    'Add 2 minced cloves.',
    'Add 2 cloves.',
    'Use 1.5.',
  ])('does not bold anything in %j', (text) => {
    expect(bolded(text)).toEqual([]);
  });
});
