import type {
  ShoppingListCategory,
  ShoppingListContributingSlot,
  ShoppingListLine,
} from '../../../shared/src/index.ts';

// Pure aggregation for `shopping.getForPlan`. Takes the flat contribution rows
// produced by the procedure's two SELECTs (meal-recipe contributions + cooks-
// base contributions, unioned) and produces the nested-by-category output.
//
// The procedure scales each contribution in SQL so this helper never does
// decimal arithmetic on irrational ratios — it only sums already-rounded
// numeric(10,3) strings. Summing happens via integer math on the
// 3-decimal-shifted value (`'1.500' → 1500n`), avoiding JS float drift on
// the aggregate without pulling in `decimal.js`. The scale guarantees: at the
// project's numeric(10,3) precision a bigint of 13 digits (~10^13) holds
// every plausible sum.

export interface ShoppingContribution {
  slotId: number;
  slotDate: string;
  recipeId: number;
  recipeName: string;
  ingredientId: number;
  ingredientName: string;
  categoryId: number;
  categoryName: string;
  unitId: number;
  unitName: string;
  // numeric(10,3) as string, already scaled by the SQL projection.
  scaledQuantity: string;
}

// Aggregate contribution rows into the nested category/line tree. Returns
// `[]` for an empty input. Sorting:
//   - categories: by category name
//   - lines within a category: by ingredient name
//   - contributingSlots within a line: by (date, slotId)
// All comparisons are case-insensitive locale string compares for the names.
export function aggregateContributions(
  contributions: ShoppingContribution[],
): ShoppingListCategory[] {
  // ingredient bucket — accumulates one `ShoppingListLine` per ingredient_id.
  interface IngredientBucket {
    ingredient: { id: number; name: string };
    category: { id: number; name: string };
    unit: { id: number; name: string };
    totalMilli: bigint;
    // per (slotId, recipeId) — collapses within-slot duplicates of the same
    // recipe ("onion sliced" + "onion diced" → one entry).
    contributingSlots: Map<string, ContributingAccumulator>;
  }
  interface ContributingAccumulator {
    slotId: number;
    recipeId: number;
    recipeName: string;
    date: string;
    scaledMilli: bigint;
  }

  const ingredientBuckets = new Map<number, IngredientBucket>();

  for (const row of contributions) {
    const milli = parseMilliFromFixed3(row.scaledQuantity);

    let bucket = ingredientBuckets.get(row.ingredientId);
    if (!bucket) {
      bucket = {
        ingredient: { id: row.ingredientId, name: row.ingredientName },
        category: { id: row.categoryId, name: row.categoryName },
        unit: { id: row.unitId, name: row.unitName },
        totalMilli: 0n,
        contributingSlots: new Map(),
      };
      ingredientBuckets.set(row.ingredientId, bucket);
    }

    bucket.totalMilli += milli;

    const contributingKey = `${row.slotId.toString()}:${row.recipeId.toString()}`;
    const existing = bucket.contributingSlots.get(contributingKey);
    if (existing) {
      existing.scaledMilli += milli;
    } else {
      bucket.contributingSlots.set(contributingKey, {
        slotId: row.slotId,
        recipeId: row.recipeId,
        recipeName: row.recipeName,
        date: row.slotDate,
        scaledMilli: milli,
      });
    }
  }

  // category bucket — accumulates lines per category_id.
  interface CategoryBucket {
    category: { id: number; name: string };
    lines: ShoppingListLine[];
  }
  const categoryBuckets = new Map<number, CategoryBucket>();

  for (const ingredient of ingredientBuckets.values()) {
    const contributingSlots: ShoppingListContributingSlot[] = [
      ...ingredient.contributingSlots.values(),
    ]
      .sort(compareContribution)
      .map((entry) => ({
        slotId: entry.slotId,
        recipeId: entry.recipeId,
        recipeName: entry.recipeName,
        date: entry.date,
        scaledQuantity: formatFixed3FromMilli(entry.scaledMilli),
      }));

    const line: ShoppingListLine = {
      ingredient: ingredient.ingredient,
      unit: ingredient.unit,
      totalQuantity: formatFixed3FromMilli(ingredient.totalMilli),
      contributingSlots,
    };

    let cat = categoryBuckets.get(ingredient.category.id);
    if (!cat) {
      cat = { category: ingredient.category, lines: [] };
      categoryBuckets.set(ingredient.category.id, cat);
    }
    cat.lines.push(line);
  }

  const categories: ShoppingListCategory[] = [...categoryBuckets.values()].map(
    (cat) => ({
      category: cat.category,
      lines: cat.lines.sort((a, b) =>
        compareIgnoreCase(a.ingredient.name, b.ingredient.name),
      ),
    }),
  );
  categories.sort((a, b) =>
    compareIgnoreCase(a.category.name, b.category.name),
  );

  return categories;
}

function compareContribution(
  a: { date: string; slotId: number },
  b: { date: string; slotId: number },
): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return a.slotId - b.slotId;
}

function compareIgnoreCase(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

// Parse a Postgres numeric(10,3) string ("1.500", "12", ".25") into an
// integer count of thousandths (1500n, 12000n, 250n). Postgres always emits
// a leading digit and either no decimal point or up to three fractional
// digits at this column scale, but the parser tolerates 0–3 decimals and a
// leading `+`/`-` defensively. Throws on malformed input rather than
// silently producing 0 — a malformed contribution row would skew the total
// by exactly the missing value.
function parseMilliFromFixed3(value: string): bigint {
  const match = /^([+-]?)(\d+)(?:\.(\d{1,3}))?$/.exec(value);
  if (!match) {
    throw new Error(`shopping-aggregation: invalid numeric "${value}"`);
  }
  const sign = match[1] === '-' ? -1n : 1n;
  const wholePart = match[2] ?? '0';
  const fracPart = (match[3] ?? '').padEnd(3, '0');
  return sign * (BigInt(wholePart) * 1000n + BigInt(fracPart));
}

function formatFixed3FromMilli(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 1000n;
  const frac = abs % 1000n;
  const fracStr = frac.toString().padStart(3, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fracStr}`;
}
