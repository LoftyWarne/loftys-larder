import { AFTER, BEFORE, NUMBER, escapeRegExp } from '@/lib/step-highlights.ts';
import { trimTrailingZeros } from '@/lib/quantity-input.ts';

export interface SuggestableIngredient {
  ingredientId: number;
  name: string;
  unitName: string;
  // The recipe total, for "half the butter"; `null` when it isn't known.
  total: number | null;
}

export interface StepIngredientSuggestion {
  ingredientId: number;
  // A `numeric(10,3)`-style decimal string, or `null` when the text states no
  // amount (which the recipe page then reads as "what's left").
  quantity: string | null;
}

interface NameSpan {
  start: number;
  end: number;
}

const FRACTION_GLYPHS: Readonly<Record<string, number>> = {
  '½': 1 / 2,
  '¼': 1 / 4,
  '¾': 3 / 4,
  '⅓': 1 / 3,
  '⅔': 2 / 3,
  '⅛': 1 / 8,
};

// Which of the recipe's ingredients a method step mentions, and how much of
// each, worked out from the step text (DEC-99). Matching follows the one-off
// migration fill: names lose bracketed parts, may take an s/es plural, and
// longer names claim their text first. A last-word fallback ("potatoes" →
// Sweet Potato) applies only when no other ingredient in the recipe uses that
// word. Amounts come from a number and the ingredient's own unit written
// next to the name ("50 g butter", "butter (50 g)", "2 onions" for `piece`),
// or "half the X". Suggestions follow the order of first mention.
export function suggestStepIngredients(
  text: string,
  ingredients: readonly SuggestableIngredient[],
): StepIngredientSuggestion[] {
  const unique = new Map<number, SuggestableIngredient & { clean: string }>();
  for (const ingredient of ingredients) {
    const clean = cleanName(ingredient.name);
    if (clean.length > 0 && !unique.has(ingredient.ingredientId)) {
      unique.set(ingredient.ingredientId, { ...ingredient, clean });
    }
  }
  const candidates = [...unique.values()];

  let remaining = text;
  const spansById = new Map<number, NameSpan[]>();
  const claim = (ingredientId: number, term: string): void => {
    const pattern = new RegExp(
      String.raw`${BEFORE}(?:${termSource(term)})(?:e?s)?${AFTER}`,
      'giu',
    );
    const spans: NameSpan[] = [];
    for (const match of remaining.matchAll(pattern)) {
      const start = match.index + (match[1]?.length ?? 0);
      spans.push({ start, end: match.index + match[0].length });
    }
    if (spans.length === 0) return;
    spansById.set(ingredientId, spans);
    for (const { start, end } of spans) {
      remaining =
        remaining.slice(0, start) +
        ' '.repeat(end - start) +
        remaining.slice(end);
    }
  };

  const byLength = (a: string, b: string): number => b.length - a.length;
  for (const candidate of [...candidates].sort(
    (a, b) => byLength(a.clean, b.clean) || a.ingredientId - b.ingredientId,
  )) {
    claim(candidate.ingredientId, candidate.clean);
  }

  const fallbacks = candidates.flatMap((candidate) => {
    const words = candidate.clean.split(' ');
    const lastWord = words[words.length - 1];
    if (words.length < 2 || !lastWord) return [];
    if (spansById.has(candidate.ingredientId)) return [];
    const shared = candidates.some(
      (other) =>
        other.ingredientId !== candidate.ingredientId &&
        other.clean.split(' ').includes(lastWord),
    );
    return shared ? [] : [{ ingredientId: candidate.ingredientId, lastWord }];
  });
  for (const { ingredientId, lastWord } of fallbacks.sort(
    (a, b) =>
      byLength(a.lastWord, b.lastWord) || a.ingredientId - b.ingredientId,
  )) {
    claim(ingredientId, lastWord);
  }

  return [...spansById.entries()]
    .sort(([, a], [, b]) => (a[0]?.start ?? 0) - (b[0]?.start ?? 0))
    .flatMap(([ingredientId, spans]) => {
      const ingredient = unique.get(ingredientId);
      if (!ingredient) return [];
      return [{ ingredientId, quantity: amountFor(text, spans, ingredient) }];
    });
}

function cleanName(name: string): string {
  return name
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function termSource(term: string): string {
  return term
    .split(' ')
    .map(escapeRegExp)
    .join(String.raw`\s+`);
}

function amountFor(
  text: string,
  spans: readonly NameSpan[],
  ingredient: SuggestableIngredient,
): string | null {
  for (const { start, end } of spans) {
    const value =
      amountBefore(text.slice(0, start), ingredient) ??
      amountAfter(text.slice(end), ingredient.unitName);
    if (value !== null && value > 0) {
      return trimTrailingZeros((Math.round(value * 1000) / 1000).toFixed(3));
    }
  }
  return null;
}

function unitSource(unitName: string): string {
  return String.raw`${escapeRegExp(unitName)}(?:e?s)?\.?`;
}

function amountBefore(
  prefix: string,
  ingredient: SuggestableIngredient,
): number | null {
  if (/\bhalf\s+(?:of\s+)?(?:the\s+)?$/iu.test(prefix)) {
    return ingredient.total === null ? null : ingredient.total / 2;
  }
  // A `piece` amount can be a bare count: "2 onions".
  const unit =
    ingredient.unitName === 'piece'
      ? String.raw`(?:${unitSource('piece')}\s+(?:of\s+)?)?`
      : String.raw`${unitSource(ingredient.unitName)}\s+(?:of\s+)?`;
  const pattern = new RegExp(
    String.raw`(^|[^\p{L}\p{N}.\-–/])(${NUMBER})\s?${unit}(?:the\s+)?$`,
    'iu',
  );
  const match = pattern.exec(prefix);
  if (!match) return null;
  // The upper end of a range ("2-3 tbsp", "2 to 3 tbsp") isn't an amount.
  const beforeNumber = prefix.slice(0, match.index + (match[1]?.length ?? 0));
  if (/(?:\d\s*[-–]\s*|\bto\s+)$/iu.test(beforeNumber)) return null;
  return parseNumber(match[2] ?? '');
}

function amountAfter(suffix: string, unitName: string): number | null {
  const unit =
    unitName === 'piece'
      ? String.raw`(?:\s?${unitSource('piece')})?`
      : String.raw`\s?${unitSource(unitName)}`;
  const pattern = new RegExp(
    String.raw`^\s*\(\s*(${NUMBER})${unit}\s*\)`,
    'iu',
  );
  const match = pattern.exec(suffix);
  return match ? parseNumber(match[1] ?? '') : null;
}

function parseNumber(raw: string): number | null {
  const value = raw.replace(/\s+/g, '');
  const fraction = /^(\d+)\/(\d+)$/.exec(value);
  if (fraction) {
    const denominator = Number(fraction[2]);
    return denominator > 0 ? Number(fraction[1]) / denominator : null;
  }
  const glyph = value.slice(-1);
  const glyphValue = FRACTION_GLYPHS[glyph];
  if (glyphValue !== undefined) {
    const whole = value.slice(0, -1);
    return (whole.length > 0 ? Number(whole) : 0) + glyphValue;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
