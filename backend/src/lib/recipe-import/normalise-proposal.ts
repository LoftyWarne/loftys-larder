import type { z } from 'zod';

import {
  normaliseRecipeTagName,
  RECIPE_IMPORT_ESTIMATE_PATH_PATTERN,
  RECIPE_IMPORT_NOTE_MAX_LENGTH,
  RECIPE_IMPORT_NOTES_MAX,
  RECIPE_IMPORT_NUTRITION_FIELDS,
  RECIPE_TAGS_MAX,
  recipeImportCandidateSchema,
  recipeImportProposalContentSchema,
  type RecipeImportCandidate,
  type RecipeImportNutritionField,
  type RecipeImportProposalContent,
} from '../../../../shared/src/index.ts';
import { stripMarkdown } from '../model-features/plain-text.ts';
import type { RecipeReaderHousehold } from '../recipe-reader/types.ts';

// Every reader's candidate passes through here, whichever adapter produced
// it (DEC-109): it must fit the proposal schema, its text becomes plain
// text, any id that wasn't sent to the reader loses its match, and cost and
// image stay blank. Estimate marks are kept as given; nothing is inferred.

export type NormaliseProposalResult =
  | { ok: true; proposal: RecipeImportProposalContent }
  // Schema paths only, never model text, so they can be logged.
  | { ok: false; issues: string[] };

type ProposalDraft = z.input<typeof recipeImportProposalContentSchema>;
type CandidateRef = RecipeImportCandidate['ingredients'][number]['ingredient'];
type ProposalRef = { id: number } | { newKey: string };
type ProposedIngredient = ProposalDraft['newIngredients'][number];

const MAX_REPORTED_ISSUES = 5;
const STEP_ESTIMATE_FIELDS = new Set([
  'instruction',
  'safetyNote',
  'tip',
  'prepAhead',
  'ingredients',
]);

class CandidateReferenceError extends Error {}

export function normaliseProposal(
  candidate: unknown,
  household: RecipeReaderHousehold,
): NormaliseProposalResult {
  const parsed = recipeImportCandidateSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, issues: issuePaths(parsed.error) };

  let draft: ProposalDraft;
  try {
    draft = buildProposal(parsed.data, household);
  } catch (error) {
    if (error instanceof CandidateReferenceError) {
      return { ok: false, issues: [error.message] };
    }
    throw error;
  }

  const proposal = recipeImportProposalContentSchema.safeParse(draft);
  if (!proposal.success) {
    return { ok: false, issues: issuePaths(proposal.error) };
  }
  return { ok: true, proposal: proposal.data };
}

function buildProposal(
  candidate: RecipeImportCandidate,
  household: RecipeReaderHousehold,
): ProposalDraft {
  const ingredientIds = new Set(household.ingredients.map((i) => i.id));
  const categoryIds = new Set(household.categories.map((c) => c.id));
  const unitIds = new Set(household.units.map((u) => u.id));
  const prepTypeIds = new Set(household.prepTypes.map((p) => p.id));
  const sourceIds = new Set(household.sources.map((s) => s.id));
  const sourceByName = new Map(
    household.sources.map((s) => [s.name.toLowerCase(), s.id]),
  );
  const tagByName = new Map(
    household.tags.map((t) => [t.name.toLowerCase(), t.name]),
  );

  const newIngredients: ProposedIngredient[] = candidate.newIngredients.map(
    (ingredient) => ({
      key: ingredient.key.trim(),
      name: plain(ingredient.name),
      categoryId: known(categoryIds, ingredient.categoryId),
      defaultUnitId: known(unitIds, ingredient.defaultUnitId),
      isPlant: ingredient.isPlant,
      averageShelfLifeDays: shelfLife(ingredient.averageShelfLifeDays),
    }),
  );
  assertUnique(
    newIngredients.map((i) => i.key),
    'newIngredients.key',
  );
  const newKeys = new Set(newIngredients.map((i) => i.key));
  const newKeyByName = new Map(
    newIngredients.map((i) => [i.name.toLowerCase(), i.key]),
  );

  // An id the household doesn't have becomes a proposed new ingredient by
  // the name the reader gave it, shared by every row and step naming it.
  let generated = 0;
  const resolveRef = (ref: CandidateRef): ProposalRef => {
    if ('newKey' in ref) {
      const key = ref.newKey.trim();
      if (!newKeys.has(key))
        throw new CandidateReferenceError('ingredient.newKey');
      return { newKey: key };
    }
    if (ingredientIds.has(ref.id)) return { id: ref.id };
    const name = plain(ref.name);
    const existing = newKeyByName.get(name.toLowerCase());
    if (existing !== undefined) return { newKey: existing };
    let key: string;
    do {
      generated += 1;
      key = `x${String(generated)}`;
    } while (newKeys.has(key));
    newIngredients.push({
      key,
      name,
      categoryId: null,
      defaultUnitId: null,
      isPlant: false,
      averageShelfLifeDays: null,
    });
    newKeys.add(key);
    newKeyByName.set(name.toLowerCase(), key);
    return { newKey: key };
  };

  const rows = candidate.ingredients.map((row) => ({
    key: row.key.trim(),
    ingredient: resolveRef(row.ingredient),
    quantity: quantity(row.quantity),
    prepTypeId: known(prepTypeIds, row.prepTypeId),
    isOptional: row.isOptional,
    originalLine: plain(row.originalLine),
  }));
  assertUnique(
    rows.map((row) => row.key),
    'ingredients.key',
  );

  const steps = candidate.method.map((step) => {
    const links = new Map<
      string,
      { ingredient: ProposalRef; quantity: string | null }
    >();
    for (const link of step.ingredients) {
      const ingredient = resolveRef(link.ingredient);
      const refKey =
        'id' in ingredient ? `id:${String(ingredient.id)}` : ingredient.newKey;
      if (links.has(refKey)) continue;
      links.set(refKey, {
        ingredient,
        quantity: stepAmount(link.quantity),
      });
    }
    return {
      key: step.key.trim(),
      instruction: plain(step.instruction),
      safetyNote: optionalPlain(step.safetyNote),
      tip: optionalPlain(step.tip),
      prepAhead: step.prepAhead,
      ingredients: [...links.values()],
    };
  });
  assertUnique(
    steps.map((step) => step.key),
    'method.key',
  );

  const header = candidate.header;
  const tags = [
    ...new Set(
      candidate.tags.flatMap((tag) => {
        const name = tagByName.get(
          normaliseRecipeTagName(stripMarkdown(tag)).toLowerCase(),
        );
        return name === undefined ? [] : [name];
      }),
    ),
  ].slice(0, RECIPE_TAGS_MAX);

  const rowKeys = new Set(rows.map((row) => row.key));
  const stepKeys = new Set(steps.map((step) => step.key));
  // Nutrition arrives as a list but is marked by field, like the rest of
  // the header.
  const headerFields = new Set<string>([
    ...Object.keys(header).filter((field) => field !== 'nutrition'),
    ...RECIPE_IMPORT_NUTRITION_FIELDS,
  ]);
  const nutrition = nutritionByField(header.nutrition);
  const seenPaths = new Set<string>();
  const estimates = candidate.estimates.filter((mark) => {
    if (seenPaths.has(mark.path)) return false;
    if (!RECIPE_IMPORT_ESTIMATE_PATH_PATTERN.test(mark.path)) return false;
    if (!estimateTargetExists(mark.path, headerFields, rowKeys, stepKeys)) {
      return false;
    }
    seenPaths.add(mark.path);
    return true;
  });

  return {
    header: {
      name: plain(header.name),
      description: optionalPlain(header.description),
      baseServings: Math.round(header.baseServings),
      activeTimeMins: whole(header.activeTimeMins),
      totalTimeMins: whole(header.totalTimeMins),
      caloriesPerServing: whole(nutrition.caloriesPerServing ?? null),
      proteinPerServing: grams(nutrition.proteinPerServing ?? null),
      carbsPerServing: grams(nutrition.carbsPerServing ?? null),
      fatPerServing: grams(nutrition.fatPerServing ?? null),
      saturatedFatPerServing: grams(nutrition.saturatedFatPerServing ?? null),
      fibrePerServing: grams(nutrition.fibrePerServing ?? null),
      sugarPerServing: grams(nutrition.sugarPerServing ?? null),
      saltPerServing: grams(nutrition.saltPerServing ?? null),
      // A URL isn't prose, so it's only trimmed.
      sourceUrl: emptyToNull(header.sourceUrl.trim()),
      sourceDetail: optionalPlain(header.sourceDetail),
      estimatedCostPerServing: null,
      imageUrl: null,
    },
    source: resolveSource(candidate.source, sourceIds, sourceByName),
    newIngredients,
    ingredients: rows,
    method: steps,
    tags,
    estimates,
    notes: candidate.notes
      .map((note) => plain(note).slice(0, RECIPE_IMPORT_NOTE_MAX_LENGTH).trim())
      .filter((note) => note.length > 0)
      .slice(0, RECIPE_IMPORT_NOTES_MAX),
  };
}

// The first value given for each field; a repeat is ignored.
function nutritionByField(
  entries: RecipeImportCandidate['header']['nutrition'],
): Partial<Record<RecipeImportNutritionField, number>> {
  const values: Partial<Record<RecipeImportNutritionField, number>> = {};
  for (const { field, value } of entries) values[field] ??= value;
  return values;
}

function resolveSource(
  source: RecipeImportCandidate['source'],
  sourceIds: Set<number>,
  sourceByName: Map<string, number>,
): ProposalDraft['source'] {
  if (source === null) return null;
  if ('id' in source)
    return sourceIds.has(source.id) ? { id: source.id } : null;
  const name = plain(source.newName);
  if (name.length === 0) return null;
  const existing = sourceByName.get(name.toLowerCase());
  return existing === undefined ? { newName: name } : { id: existing };
}

function estimateTargetExists(
  path: string,
  headerFields: Set<string>,
  rowKeys: Set<string>,
  stepKeys: Set<string>,
): boolean {
  if (path.startsWith('header.')) {
    return headerFields.has(path.slice('header.'.length));
  }
  const dot = path.lastIndexOf('.');
  const target = path.slice(path.indexOf(':') + 1, dot);
  if (path.startsWith('ingredient:')) return rowKeys.has(target);
  return stepKeys.has(target) && STEP_ESTIMATE_FIELDS.has(path.slice(dot + 1));
}

function plain(value: string): string {
  return stripMarkdown(value);
}

function optionalPlain(value: string | null): string | null {
  return value === null ? null : emptyToNull(stripMarkdown(value));
}

function emptyToNull(value: string | null): string | null {
  return value === null || value.length === 0 ? null : value;
}

function known(ids: Set<number>, id: number | null): number | null {
  return id !== null && ids.has(id) ? id : null;
}

function whole(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

function grams(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100;
}

function shelfLife(value: number | null): number | null {
  if (value === null) return null;
  const days = Math.round(value);
  return days >= 1 && days <= 3650 ? days : null;
}

// To the `numeric(10,3)` string the write schemas take. A value that can't
// be one (negative, not finite) is left for the schema to refuse.
function quantity(value: number): string {
  if (!Number.isFinite(value) || value < 0) return String(value);
  return String(Math.round(value * 1000) / 1000);
}

function stepAmount(value: number | null): string | null {
  if (value === null) return null;
  const amount = quantity(value);
  return Number(amount) > 0 ? amount : null;
}

function assertUnique(keys: string[], path: string): void {
  if (new Set(keys).size !== keys.length)
    throw new CandidateReferenceError(path);
}

function issuePaths(error: z.ZodError): string[] {
  return error.issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => issue.path.map(String).join('.') || '(root)');
}
