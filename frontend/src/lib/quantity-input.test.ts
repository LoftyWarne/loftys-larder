import { describe, expect, it } from 'vitest';

import {
  isValidQuantityEntry,
  parseQuantityToDecimal,
  sanitizeQuantityInput,
  trimTrailingZeros,
} from './quantity-input.ts';

describe('trimTrailingZeros', () => {
  it('drops needless trailing zeros on decimals', () => {
    expect(trimTrailingZeros('50.000')).toBe('50');
    expect(trimTrailingZeros('0.500')).toBe('0.5');
    expect(trimTrailingZeros('0.333')).toBe('0.333');
  });

  it('leaves integers and fractions untouched', () => {
    expect(trimTrailingZeros('100')).toBe('100');
    expect(trimTrailingZeros('1/2')).toBe('1/2');
  });
});

describe('sanitizeQuantityInput', () => {
  it('drops non-numeric characters', () => {
    expect(sanitizeQuantityInput('1a2b3')).toBe('123');
    expect(sanitizeQuantityInput('not-a-number')).toBe('');
    expect(sanitizeQuantityInput('1,5')).toBe('15');
  });

  it('keeps a single decimal point or slash, dropping later separators', () => {
    expect(sanitizeQuantityInput('1.5')).toBe('1.5');
    expect(sanitizeQuantityInput('1/2')).toBe('1/2');
    expect(sanitizeQuantityInput('1.2.3')).toBe('1.23');
    expect(sanitizeQuantityInput('1/2/3')).toBe('1/23');
    // The first separator fixes the type; a later one of the other kind goes.
    expect(sanitizeQuantityInput('1/2.5')).toBe('1/25');
  });
});

describe('isValidQuantityEntry', () => {
  it('accepts decimals up to three places', () => {
    expect(isValidQuantityEntry('50')).toBe(true);
    expect(isValidQuantityEntry('1.5')).toBe(true);
    expect(isValidQuantityEntry('0.125')).toBe(true);
    expect(isValidQuantityEntry('1.2345')).toBe(false);
  });

  it('accepts fractions with a non-zero denominator', () => {
    expect(isValidQuantityEntry('1/2')).toBe(true);
    expect(isValidQuantityEntry('0/5')).toBe(true);
    expect(isValidQuantityEntry('1/0')).toBe(false);
    expect(isValidQuantityEntry('1/')).toBe(false);
    expect(isValidQuantityEntry('')).toBe(false);
  });
});

describe('parseQuantityToDecimal', () => {
  it('passes valid decimals through', () => {
    expect(parseQuantityToDecimal('50')).toBe('50');
    expect(parseQuantityToDecimal('1.5')).toBe('1.5');
  });

  it('converts fractions, rounding to three places and trimming zeros', () => {
    expect(parseQuantityToDecimal('1/2')).toBe('0.5');
    expect(parseQuantityToDecimal('4/2')).toBe('2');
    expect(parseQuantityToDecimal('1/3')).toBe('0.333');
    expect(parseQuantityToDecimal('1/8')).toBe('0.125');
  });

  it('returns null for invalid entries', () => {
    expect(parseQuantityToDecimal('1/0')).toBeNull();
    expect(parseQuantityToDecimal('abc')).toBeNull();
    expect(parseQuantityToDecimal('1.2345')).toBeNull();
  });
});
