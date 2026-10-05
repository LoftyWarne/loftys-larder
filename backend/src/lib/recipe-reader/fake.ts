import type { RecipeImportCandidate } from '../../../../shared/src/index.ts';
import {
  RecipeReaderRequestError,
  RecipeReaderTimeoutError,
  RecipeReaderUnavailableError,
  type RecipeReadRequest,
  type RecipeReader,
  type RecipeReading,
} from './types.ts';

// Canned outcomes for backend tests and e2e, chosen by markers in the input
// text or a page's content, or in an image's URL for an image import. Any
// other input gets a small candidate named after the input's first line, or
// after its kind, built from the household it was sent, with one matched
// ingredient, one proposed new ingredient, and a converted and a nominal
// Estimate.
export const FAKE_READER_MARKERS = {
  several: '[fake:several]',
  notARecipe: '[fake:not-a-recipe]',
  timeout: '[fake:timeout]',
  unavailable: '[fake:unavailable]',
  invalid: '[fake:invalid]',
  rejected: '[fake:rejected]',
} as const;

// Image public ids can't hold brackets or colons.
export const FAKE_READER_IMAGE_MARKERS = {
  several: 'fake-several',
  notARecipe: 'fake-not-a-recipe',
  timeout: 'fake-timeout',
  unavailable: 'fake-unavailable',
  invalid: 'fake-invalid',
  rejected: 'fake-rejected',
} as const satisfies Record<keyof typeof FAKE_READER_MARKERS, string>;

type FakeMarker = keyof typeof FAKE_READER_MARKERS;

export const FAKE_READER_MODEL = 'fake';
export const FAKE_SEVERAL_NAMES = ['Fake Soup', 'Fake Salad'];

const usage = { model: FAKE_READER_MODEL, inputTokens: 0, outputTokens: 0 };

export function createFakeRecipeReader(): RecipeReader {
  return {
    adapter: 'fake',
    model: FAKE_READER_MODEL,
    read(request, signal) {
      return Promise.resolve().then(() => readFake(request, signal));
    },
  };
}

function readFake(
  request: RecipeReadRequest,
  signal: AbortSignal,
): RecipeReading {
  if (signal.aborted) throw new RecipeReaderTimeoutError();
  const { input } = request;
  const has = (marker: FakeMarker) =>
    input.kind === 'images'
      ? input.urls.some((url) =>
          url.includes(FAKE_READER_IMAGE_MARKERS[marker]),
        )
      : (input.kind === 'text' ? input.text : input.content).includes(
          FAKE_READER_MARKERS[marker],
        );
  if (has('timeout')) {
    throw new RecipeReaderTimeoutError();
  }
  if (has('unavailable')) {
    throw new RecipeReaderUnavailableError(529);
  }
  if (has('rejected')) {
    throw new RecipeReaderRequestError(
      400,
      'invalid_request_error',
      'The fake reader refused the request',
      'req_fake',
    );
  }
  if (has('notARecipe')) {
    return { outcome: { kind: 'not_a_recipe' }, usage };
  }
  if (has('invalid')) {
    return {
      outcome: { kind: 'candidate', candidate: { header: { name: '' } } },
      usage,
    };
  }
  if (has('several') && request.pick === null) {
    return {
      outcome: { kind: 'several', names: [...FAKE_SEVERAL_NAMES] },
      usage,
    };
  }
  return {
    outcome: { kind: 'candidate', candidate: fakeCandidate(request) },
    usage,
  };
}

function fakeCandidate(request: RecipeReadRequest): RecipeImportCandidate {
  const { household, input } = request;
  const firstLine =
    input.kind === 'text'
      ? (input.text
          .split('\n')
          .map((line) => line.replaceAll(/\[fake:[a-z-]+\]/g, '').trim())
          .find((line) => line.length > 0) ?? 'Imported Recipe')
      : input.kind === 'images'
        ? 'Photographed Recipe'
        : input.url === null
          ? 'Saved Page Recipe'
          : 'Linked Recipe';
  const name = request.pick ?? firstLine.slice(0, 200);
  const known = household.ingredients[0];
  const category = household.categories[0];
  const unit = household.units[0];
  const tag = household.tags[0];

  const rows: RecipeImportCandidate['ingredients'] = [];
  if (known) {
    rows.push({
      key: 'i1',
      ingredient: { id: known.id, name: known.name },
      quantity: 30,
      prepTypeId: null,
      isOptional: false,
      originalLine: `2 tbsp ${known.name.toLowerCase()}`,
    });
  }
  rows.push({
    key: 'i2',
    ingredient: { newKey: 'n1' },
    quantity: 2,
    prepTypeId: null,
    isOptional: false,
    originalLine: 'Fake pepper to taste',
  });

  return {
    header: {
      name,
      description: '',
      baseServings: 2,
      activeTimeMins: 10,
      totalTimeMins: 20,
      nutrition: [{ field: 'caloriesPerServing', value: 410 }],
      sourceUrl: '',
      sourceDetail: '',
    },
    source: null,
    newIngredients: [
      {
        key: 'n1',
        name: 'Fake Pepper',
        categoryId: category?.id ?? null,
        defaultUnitId: unit?.id ?? null,
        isPlant: true,
        averageShelfLifeDays: null,
      },
    ],
    ingredients: rows,
    method: [
      {
        key: 's1',
        instruction: 'Cook everything together.',
        safetyNote: null,
        tip: null,
        prepAhead: null,
        ingredients: rows.map((row) => ({
          ingredient: row.ingredient,
          quantity: null,
        })),
      },
    ],
    tags: tag ? [tag.name] : [],
    estimates: [
      { path: 'header.baseServings', kind: 'estimate' },
      { path: 'header.caloriesPerServing', kind: 'estimate' },
      ...(known
        ? [{ path: 'ingredient:i1.quantity', kind: 'converted' as const }]
        : []),
      { path: 'ingredient:i2.quantity', kind: 'nominal' },
    ],
    notes: ['This proposal came from the fake reader.'],
  };
}
