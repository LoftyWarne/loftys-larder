import { describe, expect, it } from 'vitest';

import { stripMarkdown } from '../src/lib/model-features/plain-text.ts';

describe('stripMarkdown', () => {
  it.each([
    ['**Preheat** the oven', 'Preheat the oven'],
    ['Stir __well__', 'Stir well'],
    ['Fold *gently*', 'Fold gently'],
    ['Fold _gently_', 'Fold gently'],
    ['## Method', 'Method'],
    ['> A family favourite', 'A family favourite'],
    ['- 2 eggs\n* 1 onion\n+ salt', '2 eggs\n1 onion\nsalt'],
    ['From [BBC Good Food](https://www.bbcgoodfood.com)', 'From BBC Good Food'],
    ['![Finished dish](https://example.com/dish.jpg)', 'Finished dish'],
    ['Use `sea salt`', 'Use sea salt'],
    ['```\nSimmer\n```', 'Simmer'],
    ['Intro\n\n---\n\nMethod', 'Intro\n\nMethod'],
  ])('strips %j', (input, expected) => {
    expect(stripMarkdown(input)).toBe(expected);
  });

  it.each([
    '2 * 3 tins of tomatoes',
    'snake_case_name stays',
    '1.5 kg flour',
    '50% cocoa',
    '1. Preheat the oven',
    'Mix -- then rest',
  ])('leaves %j alone', (input) => {
    expect(stripMarkdown(input)).toBe(input);
  });

  it('trims and collapses runs of blank lines', () => {
    expect(stripMarkdown('  Chop.\n\n\n\nFry.  ')).toBe('Chop.\n\nFry.');
  });
});
