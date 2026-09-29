// Render-time emphasis for method-step text (DEC-95). Nothing here is stored:
// the instruction stays plain text (DEC-49) and this only decides which
// substrings the detail page wraps in <strong>.

export interface StepSegment {
  text: string;
  bold: boolean;
}

export interface StepHighlightContext {
  ingredientNames: readonly string[];
  unitNames: readonly string[];
}

interface Span {
  start: number;
  end: number;
}

const COMMON_UNITS = ['g', 'kg', 'ml', 'l', 'tsp', 'tbsp', 'cup', 'pinch'];

const NUMBER = String.raw`(?:\d+\/\d+|\d+(?:\.\d+)?(?:\s?[½¼¾⅓⅔⅛])?|[½¼¾⅓⅔⅛])`;
const AMOUNT = String.raw`${NUMBER}(?:\s*[-–]\s*${NUMBER}|\s+to\s+${NUMBER})?`;
// A capture group rather than a lookbehind: lookbehind needs Safari 16.4+.
// Excluding `.` stops a match starting inside a decimal.
const BEFORE = String.raw`(^|[^\p{L}\p{N}.])`;
const AFTER = String.raw`(?![\p{L}\p{N}])`;

const TIME_PATTERN = new RegExp(
  String.raw`${BEFORE}${AMOUNT}\s?(?:seconds?|secs?|minutes?|mins?|hours?|hrs?)${AFTER}`,
  'giu',
);
const TEMPERATURE_PATTERN = new RegExp(
  String.raw`${BEFORE}${AMOUNT}\s?(?:°\s?[CF]?|[CF])(?:\s+fan)?${AFTER}`,
  'giu',
);
const GAS_MARK_PATTERN = new RegExp(
  String.raw`${BEFORE}gas\s+mark\s+${AMOUNT}${AFTER}`,
  'giu',
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function alternation(words: readonly string[]): string | null {
  const unique = [...new Set(words.map((w) => w.trim().toLowerCase()))]
    .filter((w) => w.length > 0)
    .sort((a, b) => b.length - a.length);
  if (unique.length === 0) return null;
  return unique
    .map((w) => escapeRegExp(w).replace(/\s+/g, String.raw`\s+`))
    .join('|');
}

function quantityPattern(unitNames: readonly string[]): RegExp | null {
  const units = alternation([...COMMON_UNITS, ...unitNames]);
  if (units === null) return null;
  return new RegExp(
    String.raw`${BEFORE}${AMOUNT}\s?(?:${units})(?:e?s)?${AFTER}`,
    'giu',
  );
}

function ingredientPattern(ingredientNames: readonly string[]): RegExp | null {
  const names = alternation(
    ingredientNames.map((name) => name.replace(/\([^)]*\)/g, ' ')),
  );
  if (names === null) return null;
  return new RegExp(String.raw`${BEFORE}(?:${names})(?:e?s)?${AFTER}`, 'giu');
}

function collect(pattern: RegExp, text: string, spans: Span[]): void {
  for (const match of text.matchAll(pattern)) {
    const prefixLength = match[1]?.length ?? 0;
    spans.push({
      start: match.index + prefixLength,
      end: match.index + match[0].length,
    });
  }
}

// Longest span wins an overlap; ties go to the earlier one.
function resolveOverlaps(spans: Span[]): Span[] {
  const byPriority = [...spans].sort(
    (a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start,
  );
  const kept: Span[] = [];
  for (const span of byPriority) {
    if (kept.every((k) => span.end <= k.start || span.start >= k.end)) {
      kept.push(span);
    }
  }
  return kept.sort((a, b) => a.start - b.start);
}

export function highlightStep(
  text: string,
  context: StepHighlightContext,
): StepSegment[] {
  const patterns = [
    TIME_PATTERN,
    TEMPERATURE_PATTERN,
    GAS_MARK_PATTERN,
    quantityPattern(context.unitNames),
    ingredientPattern(context.ingredientNames),
  ];
  const spans: Span[] = [];
  for (const pattern of patterns) {
    if (pattern !== null) collect(pattern, text, spans);
  }

  const segments: StepSegment[] = [];
  let cursor = 0;
  for (const span of resolveOverlaps(spans)) {
    if (span.start > cursor) {
      segments.push({ text: text.slice(cursor, span.start), bold: false });
    }
    segments.push({ text: text.slice(span.start, span.end), bold: true });
    cursor = span.end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), bold: false });
  }
  return segments;
}
