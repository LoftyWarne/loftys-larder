import type { RecipeImportEstimate } from '@loftys-larder/shared';

import { NUTRITION_FIELDS, type NutritionKey } from '@/lib/nutrition.ts';

// Estimate marks in Import Review (DEC-106, DEC-108). A mark sits beside the
// data by path: `header.<field>`, `ingredient:<row key>.quantity` and
// `step:<step key>.<field>`. Editing a field clears its mark for good.

export type EstimateKind = RecipeImportEstimate['kind'];

export const ESTIMATE_LABELS: Readonly<Record<EstimateKind, string>> = {
  estimate: 'Estimated',
  converted: 'Converted — check the amount',
  nominal: 'Not in the original — amount guessed',
};

export const STEP_ESTIMATE_FIELDS = [
  'safetyNote',
  'tip',
  'prepAhead',
  'ingredients',
] as const;

export type StepEstimateField = (typeof STEP_ESTIMATE_FIELDS)[number];

export function headerEstimatePath(field: string): string {
  return `header.${field}`;
}

export function quantityEstimatePath(rowKey: string): string {
  return `ingredient:${rowKey}.quantity`;
}

export function stepEstimatePath(stepKey: string, field: string): string {
  return `step:${stepKey}.${field}`;
}

export function indexEstimates(
  marks: readonly RecipeImportEstimate[],
): ReadonlyMap<string, EstimateKind> {
  return new Map(marks.map((mark) => [mark.path, mark.kind]));
}

// Returns `marks` itself when nothing was cleared, so callers can tell
// whether there's anything to save.
export function clearEstimates(
  marks: readonly RecipeImportEstimate[],
  paths: ReadonlySet<string>,
): readonly RecipeImportEstimate[] {
  if (paths.size === 0) return marks;
  const kept = marks.filter((mark) => !paths.has(mark.path));
  return kept.length === marks.length ? marks : kept;
}

export function changedHeaderPaths(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): Set<string> {
  const paths = new Set<string>();
  for (const field of new Set([
    ...Object.keys(before),
    ...Object.keys(after),
  ])) {
    if (!Object.is(before[field], after[field])) {
      paths.add(headerEstimatePath(field));
    }
  }
  return paths;
}

interface KeyedRow {
  key?: string;
  quantity: string;
}

// A row that's gone counts as changed.
export function changedQuantityPaths(
  before: readonly KeyedRow[],
  after: readonly KeyedRow[],
): Set<string> {
  const afterByKey = new Map(
    after.flatMap((row) => (row.key ? [[row.key, row] as const] : [])),
  );
  const paths = new Set<string>();
  for (const row of before) {
    if (!row.key) continue;
    const next = afterByKey.get(row.key);
    if (next?.quantity !== row.quantity) {
      paths.add(quantityEstimatePath(row.key));
    }
  }
  return paths;
}

type KeyedStep = { key?: string } & Partial<Record<StepEstimateField, unknown>>;

export function changedStepPaths(
  before: readonly KeyedStep[],
  after: readonly KeyedStep[],
): Set<string> {
  const afterByKey = new Map(
    after.flatMap((step) => (step.key ? [[step.key, step] as const] : [])),
  );
  const paths = new Set<string>();
  for (const step of before) {
    if (!step.key) continue;
    const next = afterByKey.get(step.key);
    for (const field of STEP_ESTIMATE_FIELDS) {
      if (
        !next ||
        JSON.stringify(next[field] ?? null) !==
          JSON.stringify(step[field] ?? null)
      ) {
        paths.add(stepEstimatePath(step.key, field));
      }
    }
  }
  return paths;
}

const NUTRITION_PATHS = new Set(
  NUTRITION_FIELDS.map((field) => headerEstimatePath(field.key)),
);

// Sets `nutritionIsEstimated` on the recipe at "Create recipe" (DEC-106).
export function hasNutritionEstimate(
  marks: readonly RecipeImportEstimate[],
): boolean {
  return marks.some((mark) => NUTRITION_PATHS.has(mark.path));
}

export function withoutNutritionEstimates(
  marks: readonly RecipeImportEstimate[],
): readonly RecipeImportEstimate[] {
  return clearEstimates(marks, NUTRITION_PATHS);
}

// Marks every nutrition value that's filled in, for a cook who ticks
// "Estimated" again.
export function withNutritionEstimates(
  marks: readonly RecipeImportEstimate[],
  values: Partial<Record<NutritionKey, unknown>>,
): readonly RecipeImportEstimate[] {
  const marked = new Set(marks.map((mark) => mark.path));
  const added = NUTRITION_FIELDS.flatMap((field) => {
    const path = headerEstimatePath(field.key);
    const value = values[field.key];
    if (marked.has(path) || value === null || value === undefined) return [];
    return [{ path, kind: 'estimate' as const }];
  });
  return added.length === 0 ? marks : [...marks, ...added];
}
