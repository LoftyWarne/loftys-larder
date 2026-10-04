import type {
  RecipeImportEstimate,
  RecipeImportProposal,
  RecipeImportProposedIngredient,
} from '@loftys-larder/shared';

import type { HeaderFormValues } from '@/components/recipe-editor/header-fields.tsx';
import type {
  IngredientDraftLine,
  IngredientPickerOption,
} from '@/components/recipe-editor/ingredient-list.tsx';
import type { MethodDraftStep } from '@/components/recipe-editor/method-editor.tsx';
import { trimTrailingZeros } from '@/lib/quantity-input.ts';
import { hasNutritionEstimate } from '@/lib/recipe-import-estimates.ts';

// Import Review's sections. They're owned by the editor and autosaved into
// the import draft beside the server's proposal; the proposal is mapped into
// them on first open and never read for them again (DEC-108).
export interface ImportReviewSections {
  header: HeaderFormValues;
  ingredients: IngredientDraftLine[];
  method: MethodDraftStep[];
  tags: string[];
  newIngredients: RecipeImportProposedIngredient[];
  // A proposed new source by name; `header.sourceId` holds an existing one.
  newSource: string | null;
  estimates: readonly RecipeImportEstimate[];
}

export type ImportReviewSectionKey = keyof ImportReviewSections;

// `ingredientsById` resolves a matched ingredient's name and unit. A row
// whose ingredient isn't there any more starts with none picked.
export function proposalToSections(
  proposal: RecipeImportProposal,
  ingredientsById: ReadonlyMap<number, IngredientPickerOption>,
): ImportReviewSections {
  const { header, source } = proposal;
  return {
    header: {
      ...header,
      sourceId: source !== null && 'id' in source ? source.id : null,
      nutritionIsEstimated: hasNutritionEstimate(proposal.estimates),
      isBase: false,
    },
    ingredients: proposal.ingredients.map((row) => ({
      key: row.key,
      ingredient:
        'id' in row.ingredient
          ? (ingredientsById.get(row.ingredient.id) ?? null)
          : null,
      ...('newKey' in row.ingredient ? { newKey: row.ingredient.newKey } : {}),
      quantity: trimTrailingZeros(row.quantity),
      prepTypeId: row.prepTypeId,
      isOptional: row.isOptional,
    })),
    // `followsText: false` keeps the reader's step links: the editor's text
    // matcher would otherwise replace them as soon as a step is edited.
    method: proposal.method.map((step) => ({
      key: step.key,
      instruction: step.instruction,
      safetyNote: step.safetyNote,
      tip: step.tip,
      prepAhead: step.prepAhead,
      ingredients: step.ingredients.map((link) => ({
        ...('id' in link.ingredient
          ? { ingredientId: link.ingredient.id }
          : { newKey: link.ingredient.newKey }),
        quantity:
          link.quantity === null ? '' : trimTrailingZeros(link.quantity),
      })),
      followsText: false,
    })),
    tags: [...proposal.tags],
    newIngredients: proposal.newIngredients.map((ingredient) => ({
      ...ingredient,
    })),
    newSource: source !== null && 'newName' in source ? source.newName : null,
    estimates: proposal.estimates,
  };
}

export function originalLinesByRow(
  proposal: RecipeImportProposal,
): ReadonlyMap<string, string> {
  return new Map(
    proposal.ingredients.map((row) => [row.key, row.originalLine]),
  );
}

// Sections autosaved so far, over the mapped proposal. Drafts are untyped
// JSON, so a malformed section falls back to the proposal's.
export function readStoredSections(
  mapped: ImportReviewSections,
  fields: Readonly<Record<string, unknown>>,
): ImportReviewSections {
  return {
    header: isRecord(fields.header)
      ? { ...mapped.header, ...(fields.header as Partial<HeaderFormValues>) }
      : mapped.header,
    ingredients: Array.isArray(fields.ingredients)
      ? (fields.ingredients as IngredientDraftLine[])
      : mapped.ingredients,
    method: Array.isArray(fields.method)
      ? (fields.method as MethodDraftStep[])
      : mapped.method,
    tags: parseStrings(fields.tags) ?? mapped.tags,
    newIngredients:
      parseProposedIngredients(fields.newIngredients) ?? mapped.newIngredients,
    newSource:
      'newSource' in fields
        ? typeof fields.newSource === 'string'
          ? fields.newSource
          : null
        : mapped.newSource,
    estimates: parseEstimates(fields.estimates) ?? mapped.estimates,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStrings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((item) => typeof item === 'string') ? value : null;
}

function isIdOrNull(value: unknown): value is number | null {
  return (
    value === null || (typeof value === 'number' && Number.isInteger(value))
  );
}

function parseProposedIngredients(
  value: unknown,
): RecipeImportProposedIngredient[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: RecipeImportProposedIngredient[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const {
      key,
      name,
      categoryId,
      defaultUnitId,
      isPlant,
      averageShelfLifeDays,
    } = item;
    if (
      typeof key !== 'string' ||
      typeof name !== 'string' ||
      typeof isPlant !== 'boolean' ||
      !isIdOrNull(categoryId) ||
      !isIdOrNull(defaultUnitId) ||
      !(
        averageShelfLifeDays === null ||
        typeof averageShelfLifeDays === 'number'
      )
    ) {
      return null;
    }
    parsed.push({
      key,
      name,
      categoryId,
      defaultUnitId,
      isPlant,
      averageShelfLifeDays,
    });
  }
  return parsed;
}

const ESTIMATE_KINDS = new Set(['estimate', 'converted', 'nominal']);

function parseEstimates(value: unknown): RecipeImportEstimate[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: RecipeImportEstimate[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const { path, kind } = item;
    if (typeof path !== 'string' || typeof kind !== 'string') return null;
    if (!ESTIMATE_KINDS.has(kind)) return null;
    parsed.push({ path, kind: kind as RecipeImportEstimate['kind'] });
  }
  return parsed;
}
