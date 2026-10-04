import { asc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import pino from 'pino';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  RECIPE_DRAFT_VERSION,
  recipeImportProposalSchema,
  type CreateRecipeFromImportInput,
  type RecipeImportProposal,
} from '../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../src/config.ts';
import * as schema from '../src/db/schema/index.ts';
import {
  accounts,
  sessions,
  users,
  verifications,
} from '../src/db/schema/auth.ts';
import { households } from '../src/db/schema/household.ts';
import { ingredients } from '../src/db/schema/ingredients.ts';
import { recipeDrafts } from '../src/db/schema/recipe-drafts.ts';
import { recipeHealthScores } from '../src/db/schema/recipe-health.ts';
import { recipeImportOriginals } from '../src/db/schema/recipe-import-originals.ts';
import {
  recipeIngredients,
  recipeMethod,
  recipeMethodIngredients,
  recipeSources,
  recipeTagLinks,
  recipeTags,
  recipes,
} from '../src/db/schema/recipes.ts';
import {
  ingredientCategories,
  preparationTypes,
  unitsOfMeasurement,
} from '../src/db/schema/reference.ts';
import type { DestroyImage } from '../src/lib/cloudinary.ts';
import {
  LinkNotAllowedError,
  PageUnreadableError,
  type PageFetcher,
} from '../src/lib/recipe-import/fetch-page.ts';
import {
  createFakeRecipeReader,
  FAKE_READER_IMAGE_MARKERS,
  FAKE_READER_MARKERS,
} from '../src/lib/recipe-reader/fake.ts';
import {
  RecipeReaderTimeoutError,
  type RecipeReadRequest,
  type RecipeReader,
  type RecipeReading,
} from '../src/lib/recipe-reader/types.ts';
import type { ImportRateLimitVerdict } from '../src/plugins/rate-limit.ts';
import type { AppContext } from '../src/trpc/context.ts';
import { RECIPE_IMPORT_TIMEOUT_MS } from '../src/trpc/procedures/recipe-imports.ts';
import { appRouter } from '../src/trpc/router.ts';
import {
  startTestDb,
  stopTestDb,
  TESTCONTAINER_BOOT_MS,
  type TestDb,
} from './helpers/test-db.ts';

type Schema = typeof schema;

const USER_ID = 'user-imports-test-1';
const OTHER_USER_ID = 'user-imports-test-2';
const SESSION_ID = 'session-imports-test-1';
const OTHER_HOUSEHOLD_ID = '00000000-0000-4000-8000-0000000009bb';

const RECIPE_TEXT = 'Tomato Soup\n2 tbsp olive oil\nSimmer for 20 minutes.';

const PAGE_1 = 'loftys-larder/imports/page1';
const PAGE_2 = 'loftys-larder/imports/page2';
const IMPORT_URL_PREFIX =
  'https://res.cloudinary.com/test-cloud/image/upload/c_limit,w_2576,h_2576,f_jpg,q_auto/';

const LINK = 'https://recipes.example/shakshuka?utm_source=share';
const RECIPE_JSON_LD = {
  '@context': 'https://schema.org',
  '@type': 'Recipe',
  name: 'Shakshuka',
  recipeIngredient: ['2 tbsp olive oil'],
  recipeInstructions: [{ '@type': 'HowToStep', text: 'Simmer the eggs.' }],
  aggregateRating: { ratingValue: 5 },
};
const JSON_LD_PAGE = `<html><head><title>Shakshuka</title><script type="application/ld+json">${JSON.stringify(RECIPE_JSON_LD)}</script></head><body><p>A long story.</p></body></html>`;

describe('recipe imports procedures', () => {
  let testDb: TestDb | undefined;
  let db!: NodePgDatabase<Schema>;
  let categoryId!: number;
  let unitG!: number;
  let unitMl!: number;
  let prepChopped!: number;
  let oliveOilId!: number;
  let onionId!: number;
  let outsiderId!: number;

  beforeAll(async () => {
    testDb = await startTestDb({ poolMax: 4 });
    db = testDb.db;
  }, TESTCONTAINER_BOOT_MS);

  afterAll(async () => {
    await stopTestDb(testDb);
  });

  beforeEach(async () => {
    await db.execute(sql`
      truncate table
        ${recipeDrafts},
        ${recipeImportOriginals},
        ${recipeHealthScores},
        ${recipeTagLinks},
        ${recipeTags},
        ${recipeMethodIngredients},
        ${recipeMethod},
        ${recipeIngredients},
        ${recipes},
        ${recipeSources},
        ${ingredients},
        ${preparationTypes},
        ${ingredientCategories},
        ${unitsOfMeasurement},
        ${households},
        ${users},
        ${sessions},
        ${accounts},
        ${verifications}
      restart identity cascade
    `);
    await db.insert(households).values([
      { id: CURRENT_HOUSEHOLD_ID, name: "Lofty's Larder" },
      { id: OTHER_HOUSEHOLD_ID, name: 'Other Household' },
    ]);
    await db.insert(users).values([
      {
        id: USER_ID,
        email: 'itest@example.com',
        name: 'Import Tester',
        emailVerified: true,
      },
      {
        id: OTHER_USER_ID,
        email: 'itest2@example.com',
        name: 'Other Tester',
        emailVerified: true,
      },
    ]);
    const [category] = await db
      .insert(ingredientCategories)
      .values([{ name: 'Fruit & Veg' }])
      .returning();
    const [g, ml] = await db
      .insert(unitsOfMeasurement)
      .values([{ name: 'g' }, { name: 'ml' }])
      .returning();
    const [chopped] = await db
      .insert(preparationTypes)
      .values([{ name: 'chopped' }])
      .returning();
    if (!category || !g || !ml || !chopped) throw new Error('seed failed');
    categoryId = category.id;
    unitG = g.id;
    unitMl = ml.id;
    prepChopped = chopped.id;

    const seeded = await db
      .insert(ingredients)
      .values([
        {
          householdId: CURRENT_HOUSEHOLD_ID,
          name: 'Olive Oil',
          categoryId,
          defaultUnitId: unitMl,
          isPlant: true,
        },
        {
          householdId: CURRENT_HOUSEHOLD_ID,
          name: 'Onion',
          categoryId,
          defaultUnitId: unitG,
          isPlant: true,
        },
        {
          householdId: OTHER_HOUSEHOLD_ID,
          name: 'Outsider',
          categoryId,
          defaultUnitId: unitG,
          isPlant: false,
        },
      ])
      .returning({ id: ingredients.id });
    const [oil, onion, outsider] = seeded;
    if (!oil || !onion || !outsider) throw new Error('ingredient seed failed');
    oliveOilId = oil.id;
    onionId = onion.id;
    outsiderId = outsider.id;

    await db.insert(recipeTags).values([
      { householdId: CURRENT_HOUSEHOLD_ID, name: 'Vegetarian' },
      { householdId: OTHER_HOUSEHOLD_ID, name: 'Secret' },
    ]);
    await db.insert(recipeSources).values([
      { householdId: CURRENT_HOUSEHOLD_ID, name: 'BBC Good Food' },
      { householdId: OTHER_HOUSEHOLD_ID, name: 'Other Cookbook' },
    ]);
  });

  interface ContextOptions {
    authenticated?: boolean;
    userId?: string;
    reader?: RecipeReader;
    allowStart?: () => Promise<ImportRateLimitVerdict>;
    log?: AppContext['log'];
    destroyImage?: DestroyImage;
    fetchPage?: PageFetcher;
  }

  function makeContext(options: ContextOptions = {}): AppContext {
    const authenticated = options.authenticated ?? true;
    const userId = options.userId ?? USER_ID;
    return {
      req: {} as AppContext['req'],
      reply: {} as AppContext['reply'],
      reqId: 'rid-test',
      db,
      cloudinary: {
        cloudName: 'test-cloud',
        apiKey: 'test-key',
        apiSecret: 'test-secret',
      },
      destroyImage: options.destroyImage ?? (() => Promise.resolve()),
      session: authenticated
        ? {
            id: SESSION_ID,
            userId,
            token: 'tok',
            expiresAt: new Date(Date.now() + 60_000),
            ipAddress: null,
            userAgent: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          }
        : null,
      user: authenticated
        ? {
            id: userId,
            email: 'itest@example.com',
            name: 'Tester',
            emailVerified: true,
            image: null,
            themePreference: 'system',
            createdAt: new Date(),
            updatedAt: new Date(),
          }
        : null,
      log: options.log ?? pino({ level: 'silent' }),
      recipeImport: {
        reader: options.reader ?? createFakeRecipeReader(),
        fetchPage:
          options.fetchPage ??
          (() => Promise.reject(new PageUnreadableError('network'))),
        allowStart:
          options.allowStart ??
          (() => Promise.resolve({ allowed: true, retryAfterSeconds: 0 })),
      },
    };
  }

  const createCaller = appRouter.createCaller;

  function spyReader(inner: RecipeReader = createFakeRecipeReader()) {
    const requests: RecipeReadRequest[] = [];
    const reader: RecipeReader = {
      adapter: inner.adapter,
      model: inner.model,
      read: (request, signal) => {
        requests.push(request);
        return inner.read(request, signal);
      },
    };
    return { reader, requests };
  }

  function stubReader(reading: RecipeReading): RecipeReader {
    return {
      adapter: 'fake',
      model: 'stub',
      read: () => Promise.resolve(reading),
    };
  }

  async function startImport(
    text = RECIPE_TEXT,
    options: ContextOptions = {},
  ): Promise<number> {
    const result = await createCaller(makeContext(options)).recipeImports.start(
      { input: { kind: 'text', text } },
    );
    if (result.kind !== 'draft') throw new Error('expected a draft');
    return result.draftId;
  }

  async function startImageImport(
    publicIds: string[] = [PAGE_1, PAGE_2],
    options: ContextOptions = {},
  ): Promise<number> {
    const result = await createCaller(makeContext(options)).recipeImports.start(
      { input: { kind: 'images', publicIds } },
    );
    if (result.kind !== 'draft') throw new Error('expected a draft');
    return result.draftId;
  }

  // Serves `html` for any link, as if read from `servedFrom`.
  function pageFetcher(html: string, servedFrom = LINK) {
    const calls: { url: URL; signal: AbortSignal }[] = [];
    const fetchPage: PageFetcher = (url, signal) => {
      calls.push({ url, signal });
      return Promise.resolve({ url: new URL(servedFrom), html, redirects: 0 });
    };
    return { fetchPage, calls };
  }

  function failingFetcher(error: Error) {
    const calls: URL[] = [];
    const fetchPage: PageFetcher = (url) => {
      calls.push(url);
      return Promise.reject(error);
    };
    return { fetchPage, calls };
  }

  // Records each destroy call; ids in `failing` reject.
  function destroySpy(failing: readonly string[] = []) {
    const destroyed: string[] = [];
    const destroyImage: DestroyImage = (publicId) => {
      destroyed.push(publicId);
      return failing.includes(publicId)
        ? Promise.reject(new Error('Cloudinary is down'))
        : Promise.resolve();
    };
    return { destroyImage, destroyed };
  }

  async function draftRows() {
    return db.select().from(recipeDrafts).orderBy(asc(recipeDrafts.id));
  }

  async function storedProposal(
    draftId: number,
  ): Promise<RecipeImportProposal> {
    const rows = await db
      .select({ draftData: recipeDrafts.draftData })
      .from(recipeDrafts)
      .where(eq(recipeDrafts.id, draftId));
    const data = rows[0]?.draftData as { fields: { proposal: unknown } };
    return recipeImportProposalSchema.parse(data.fields.proposal);
  }

  describe('start', () => {
    it('reads pasted text into an import draft that records the reader', async () => {
      const draftId = await startImport();

      const [row] = await draftRows();
      expect(row).toMatchObject({
        id: draftId,
        userId: USER_ID,
        recipeId: null,
        kind: 'import',
      });
      expect(row?.draftData).toMatchObject({ version: RECIPE_DRAFT_VERSION });

      const proposal = await storedProposal(draftId);
      expect(proposal.reader).toEqual({ adapter: 'fake', model: 'fake' });
      expect(proposal.input).toEqual({ kind: 'text', text: RECIPE_TEXT });
      expect(proposal.header).toMatchObject({
        name: 'Tomato Soup',
        estimatedCostPerServing: null,
        imageUrl: null,
      });
      expect(proposal.ingredients[0]).toMatchObject({
        ingredient: { id: oliveOilId },
        quantity: '30',
        originalLine: '2 tbsp olive oil',
      });
      expect(proposal.ingredients[1]?.ingredient).toEqual({ newKey: 'n1' });
      expect(proposal.newIngredients).toEqual([
        {
          key: 'n1',
          name: 'Fake Pepper',
          categoryId,
          defaultUnitId: unitG,
          isPlant: true,
          averageShelfLifeDays: null,
        },
      ]);
      expect(proposal.estimates).toEqual(
        expect.arrayContaining([
          { path: 'ingredient:i1.quantity', kind: 'converted' },
          { path: 'ingredient:i2.quantity', kind: 'nominal' },
        ]),
      );
      expect(proposal.tags).toEqual(['Vegetarian']);
    });

    it("sends the reader only this household's lists", async () => {
      const { reader, requests } = spyReader();
      await startImport(RECIPE_TEXT, { reader });

      const household = requests[0]?.household;
      expect(household?.ingredients).toEqual([
        { id: oliveOilId, name: 'Olive Oil', unitId: unitMl, unitName: 'ml' },
        { id: onionId, name: 'Onion', unitId: unitG, unitName: 'g' },
      ]);
      expect(household?.tags.map((tag) => tag.name)).toEqual(['Vegetarian']);
      expect(household?.sources.map((source) => source.name)).toEqual([
        'BBC Good Food',
      ]);
      expect(household?.units.map((unit) => unit.name)).toEqual(['g', 'ml']);
      expect(household?.categories).toEqual([
        { id: categoryId, name: 'Fruit & Veg' },
      ]);
      expect(household?.prepTypes).toEqual([
        { id: prepChopped, name: 'chopped' },
      ]);
    });

    it('returns the names of several recipes without creating a draft', async () => {
      const caller = createCaller(makeContext());
      const result = await caller.recipeImports.start({
        input: { kind: 'text', text: `${FAKE_READER_MARKERS.several} Menu` },
      });
      expect(result).toEqual({
        kind: 'several',
        names: ['Fake Soup', 'Fake Salad'],
      });
      expect(await draftRows()).toHaveLength(0);
    });

    it('imports the picked recipe', async () => {
      const { reader, requests } = spyReader();
      const caller = createCaller(makeContext({ reader }));
      const result = await caller.recipeImports.start({
        input: { kind: 'text', text: `${FAKE_READER_MARKERS.several} Menu` },
        pick: 'Fake Salad',
      });
      if (result.kind !== 'draft') throw new Error('expected a draft');
      expect(requests[0]?.pick).toBe('Fake Salad');
      expect((await storedProposal(result.draftId)).header.name).toBe(
        'Fake Salad',
      );
    });

    it('treats several recipes after a pick as a failed import', async () => {
      const reader = stubReader({
        outcome: { kind: 'several', names: ['A', 'B'] },
        usage: { model: 'stub', inputTokens: 1, outputTokens: 1 },
      });
      const caller = createCaller(makeContext({ reader }));
      await expect(
        caller.recipeImports.start({
          input: { kind: 'text', text: 'Menu' },
          pick: 'A',
        }),
      ).rejects.toMatchObject({
        code: 'BAD_GATEWAY',
        cause: { code: 'IMPORT_TRY_AGAIN', reason: 'invalid_proposal' },
      });
    });

    it.each([
      [
        'not a recipe',
        FAKE_READER_MARKERS.notARecipe,
        'UNPROCESSABLE_CONTENT',
        { code: 'IMPORT_NOT_A_RECIPE' },
      ],
      [
        'a timeout',
        FAKE_READER_MARKERS.timeout,
        'GATEWAY_TIMEOUT',
        { code: 'IMPORT_TRY_AGAIN', reason: 'timeout' },
      ],
      [
        'a provider failure',
        FAKE_READER_MARKERS.unavailable,
        'SERVICE_UNAVAILABLE',
        { code: 'IMPORT_TRY_AGAIN', reason: 'unavailable' },
      ],
      [
        'a candidate that fails the proposal schema',
        FAKE_READER_MARKERS.invalid,
        'BAD_GATEWAY',
        { code: 'IMPORT_TRY_AGAIN', reason: 'invalid_proposal' },
      ],
      [
        'a request the provider refused',
        FAKE_READER_MARKERS.rejected,
        'INTERNAL_SERVER_ERROR',
        { code: 'IMPORT_REQUEST_REJECTED' },
      ],
    ])(
      'refuses %s and creates no draft',
      async (_label, marker, code, cause) => {
        const caller = createCaller(makeContext());
        await expect(
          caller.recipeImports.start({
            input: { kind: 'text', text: `${marker} Something` },
          }),
        ).rejects.toMatchObject({ code, cause });
        expect(await draftRows()).toHaveLength(0);
      },
    );

    it('gives up after 75 seconds', async () => {
      const deadline = new AbortController();
      const timeout = vi
        .spyOn(AbortSignal, 'timeout')
        .mockReturnValue(deadline.signal);
      let reading = false;
      const reader: RecipeReader = {
        adapter: 'fake',
        model: 'slow',
        read: (_request, signal) =>
          new Promise((_resolve, reject) => {
            reading = true;
            signal.addEventListener('abort', () => {
              reject(new RecipeReaderTimeoutError());
            });
          }),
      };
      try {
        const pending = createCaller(
          makeContext({ reader }),
        ).recipeImports.start({ input: { kind: 'text', text: RECIPE_TEXT } });
        await vi.waitFor(() => {
          expect(reading).toBe(true);
        });
        deadline.abort();
        await expect(pending).rejects.toMatchObject({
          code: 'GATEWAY_TIMEOUT',
          cause: { code: 'IMPORT_TRY_AGAIN', reason: 'timeout' },
        });
        expect(timeout).toHaveBeenCalledWith(RECIPE_IMPORT_TIMEOUT_MS);
        expect(RECIPE_IMPORT_TIMEOUT_MS).toBe(75_000);
      } finally {
        timeout.mockRestore();
      }
      expect(await draftRows()).toHaveLength(0);
    });

    it('refuses imports beyond the limit without calling the reader', async () => {
      const { reader, requests } = spyReader();
      const caller = createCaller(
        makeContext({
          reader,
          allowStart: () =>
            Promise.resolve({ allowed: false, retryAfterSeconds: 120 }),
        }),
      );
      await expect(
        caller.recipeImports.start({
          input: { kind: 'text', text: RECIPE_TEXT },
        }),
      ).rejects.toMatchObject({
        code: 'TOO_MANY_REQUESTS',
        cause: { code: 'IMPORT_RATE_LIMITED', retryAfterSeconds: 120 },
      });
      expect(requests).toHaveLength(0);
      expect(await draftRows()).toHaveLength(0);
    });

    it('logs metadata only, with the request id', async () => {
      const lines: string[] = [];
      const log = pino(
        { level: 'info' },
        { write: (line) => lines.push(line) },
      ).child({ reqId: 'req-imports-1' });
      const secretText = 'Grandmas Secret Stew\n2 tbsp olive oil';

      await startImport(secretText, { log });
      await expect(
        createCaller(makeContext({ log })).recipeImports.start({
          input: {
            kind: 'text',
            text: `${FAKE_READER_MARKERS.notARecipe} Secret list`,
          },
        }),
      ).rejects.toBeDefined();

      const entries = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => 'modelUsage' in entry);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        reqId: 'req-imports-1',
        modelUsage: {
          feature: 'recipe-import',
          inputKind: 'text',
          adapter: 'fake',
          model: 'fake',
          inputTokens: 0,
          outputTokens: 0,
          outcome: 'draft',
        },
      });
      expect(entries[0]?.modelUsage).toHaveProperty('latencyMs');
      expect(entries[1]?.modelUsage).toMatchObject({
        outcome: 'IMPORT_NOT_A_RECIPE',
      });

      const output = lines.join('');
      expect(output).not.toContain('Secret Stew');
      expect(output).not.toContain('Secret list');
      expect(output).not.toContain('Fake Pepper');
    });

    it('logs why the provider refused a request, and tells the client only the code', async () => {
      const lines: string[] = [];
      const log = pino(
        { level: 'info' },
        { write: (line) => lines.push(line) },
      );

      const error: unknown = await createCaller(makeContext({ log }))
        .recipeImports.start({
          input: {
            kind: 'text',
            text: `${FAKE_READER_MARKERS.rejected} Grandmas Secret Stew`,
          },
        })
        .catch((caught: unknown) => caught);

      // The error formatter sends the cause's own fields to the client.
      expect({ ...(error as { cause: object }).cause }).toEqual({
        code: 'IMPORT_REQUEST_REJECTED',
      });
      const entry = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((logged) => 'modelUsage' in logged);
      expect(entry?.modelUsage).toMatchObject({
        outcome: 'IMPORT_REQUEST_REJECTED',
        providerStatus: 400,
        providerErrorType: 'invalid_request_error',
        providerMessage: 'The fake reader refused the request',
        providerRequestId: 'req_fake',
      });
      expect(lines.join('')).not.toContain('Secret Stew');
    });

    it('rejects unauthenticated callers', async () => {
      const caller = createCaller(makeContext({ authenticated: false }));
      await expect(
        caller.recipeImports.start({
          input: { kind: 'text', text: RECIPE_TEXT },
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });

    it('sends the reader each image as a delivery URL, in page order', async () => {
      const { reader, requests } = spyReader();
      const draftId = await startImageImport([PAGE_2, PAGE_1], { reader });

      expect(requests[0]?.input).toEqual({
        kind: 'images',
        urls: [
          `${IMPORT_URL_PREFIX}${PAGE_2}`,
          `${IMPORT_URL_PREFIX}${PAGE_1}`,
        ],
      });
      const proposal = await storedProposal(draftId);
      expect(proposal.input).toEqual({
        kind: 'images',
        publicIds: [PAGE_2, PAGE_1],
      });
      expect(proposal.header.imageUrl).toBeNull();
    });

    it.each([
      ['an image outside the imports folder', ['loftys-larder/recipes/abc']],
      ['a path that climbs out of the folder', ['loftys-larder/imports/../x']],
      ['no images', []],
      [
        'nine images',
        ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map(
          (id) => `loftys-larder/imports/${id}`,
        ),
      ],
      ['the same image twice', [PAGE_1, PAGE_1]],
    ])('refuses %s without calling the reader', async (_label, publicIds) => {
      const { reader, requests } = spyReader();
      await expect(
        createCaller(makeContext({ reader })).recipeImports.start({
          input: { kind: 'images', publicIds },
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(requests).toHaveLength(0);
      expect(await draftRows()).toHaveLength(0);
    });

    it('imports the picked recipe from the same images', async () => {
      const several = `loftys-larder/imports/${FAKE_READER_IMAGE_MARKERS.several}`;
      const { reader, requests } = spyReader();
      const caller = createCaller(makeContext({ reader }));
      const input = { kind: 'images' as const, publicIds: [several, PAGE_2] };

      expect(await caller.recipeImports.start({ input })).toEqual({
        kind: 'several',
        names: ['Fake Soup', 'Fake Salad'],
      });
      const picked = await caller.recipeImports.start({
        input,
        pick: 'Fake Salad',
      });

      expect(picked.kind).toBe('draft');
      expect(requests[1]?.input).toEqual(requests[0]?.input);
      expect(requests[1]?.pick).toBe('Fake Salad');
    });

    it('logs how many images, and never their URLs', async () => {
      const lines: string[] = [];
      const log = pino(
        { level: 'info' },
        { write: (line) => lines.push(line) },
      );

      await startImageImport([PAGE_1, PAGE_2], { log });

      const entry = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((logged) => 'modelUsage' in logged);
      expect(entry?.modelUsage).toMatchObject({
        inputKind: 'images',
        imageCount: 2,
        outcome: 'draft',
      });
      const output = lines.join('');
      expect(output).not.toContain('res.cloudinary.com');
      expect(output).not.toContain(PAGE_1);
    });

    describe('from a link', () => {
      it("reads a page's JSON-LD into a draft whose source link is the link", async () => {
        const { fetchPage, calls } = pageFetcher(
          JSON_LD_PAGE,
          'https://www.recipes.example/shakshuka',
        );
        const { reader, requests } = spyReader();
        const result = await createCaller(
          makeContext({ reader, fetchPage }),
        ).recipeImports.start({ input: { kind: 'link', url: LINK } });
        if (result.kind !== 'draft') throw new Error('expected a draft');

        expect(calls.map((call) => call.url.href)).toEqual([LINK]);
        const input = requests[0]?.input;
        expect(input).toMatchObject({
          kind: 'page',
          url: 'https://www.recipes.example/shakshuka',
          format: 'json_ld',
          truncated: false,
        });
        expect(input?.kind === 'page' && JSON.parse(input.content)).toEqual([
          {
            '@type': 'Recipe',
            name: 'Shakshuka',
            recipeIngredient: ['2 tbsp olive oil'],
            recipeInstructions: [
              { '@type': 'HowToStep', text: 'Simmer the eggs.' },
            ],
          },
        ]);

        const proposal = await storedProposal(result.draftId);
        expect(proposal.input).toEqual({ kind: 'link', url: LINK });
        expect(proposal.header.sourceUrl).toBe(LINK);
        expect(proposal.header.name).toBe('Linked Recipe');
      });

      it("puts the link in place of the reader's own source link", async () => {
        const { fetchPage } = pageFetcher(JSON_LD_PAGE);
        const inner = createFakeRecipeReader();
        const reader: RecipeReader = {
          ...inner,
          read: async (request, signal) => {
            const reading = await inner.read(request, signal);
            if (reading.outcome.kind !== 'candidate') return reading;
            const candidate = reading.outcome.candidate as {
              header: Record<string, unknown>;
            };
            candidate.header.sourceUrl = 'https://elsewhere.example/';
            return reading;
          },
        };
        const result = await createCaller(
          makeContext({ reader, fetchPage }),
        ).recipeImports.start({ input: { kind: 'link', url: LINK } });
        if (result.kind !== 'draft') throw new Error('expected a draft');

        expect((await storedProposal(result.draftId)).header.sourceUrl).toBe(
          LINK,
        );
      });

      it('reads a page without JSON-LD from its text', async () => {
        const { fetchPage } = pageFetcher(
          '<html><body><nav>Home</nav><main><h1>Lentil Soup</h1><p>Simmer the lentils.</p></main></body></html>',
        );
        const { reader, requests } = spyReader();
        await createCaller(
          makeContext({ reader, fetchPage }),
        ).recipeImports.start({ input: { kind: 'link', url: LINK } });

        const input = requests[0]?.input;
        expect(input).toMatchObject({ kind: 'page', format: 'text' });
        expect(input?.kind === 'page' && input.content).toBe(
          'Lentil Soup\nSimmer the lentils.',
        );
      });

      it.each([
        ['an http link', 'http://recipes.example/soup'],
        ['a link with a password', 'https://cook:pw@recipes.example/soup'],
        ['a link to another port', 'https://recipes.example:8443/soup'],
        ['a link that is not a web page', 'ftp://recipes.example/soup'],
      ])('refuses %s without fetching it', async (_label, url) => {
        const { fetchPage, calls } = pageFetcher(JSON_LD_PAGE);
        const { reader, requests } = spyReader();
        await expect(
          createCaller(makeContext({ reader, fetchPage })).recipeImports.start({
            input: { kind: 'link', url },
          }),
        ).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          cause: { code: 'IMPORT_LINK_NOT_ALLOWED' },
        });
        expect(calls).toHaveLength(0);
        expect(requests).toHaveLength(0);
        expect(await draftRows()).toHaveLength(0);
      });

      it('refuses a link the fetch finds leads to a private address', async () => {
        const { fetchPage } = failingFetcher(
          new LinkNotAllowedError('address'),
        );
        const { reader, requests } = spyReader();
        await expect(
          createCaller(makeContext({ reader, fetchPage })).recipeImports.start({
            input: { kind: 'link', url: LINK },
          }),
        ).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          cause: { code: 'IMPORT_LINK_NOT_ALLOWED' },
        });
        expect(requests).toHaveLength(0);
      });

      it.each([
        ['refuses the fetch', new PageUnreadableError('status', 403)],
        ['times out', new PageUnreadableError('timeout')],
        ['is too large', new PageUnreadableError('too_large')],
        ["isn't HTML", new PageUnreadableError('not_html')],
      ])(
        'reports a page that %s as unreadable, and creates no draft',
        async (_label, error) => {
          const { fetchPage } = failingFetcher(error);
          const { reader, requests } = spyReader();
          await expect(
            createCaller(
              makeContext({ reader, fetchPage }),
            ).recipeImports.start({ input: { kind: 'link', url: LINK } }),
          ).rejects.toMatchObject({
            code: 'UNPROCESSABLE_CONTENT',
            cause: { code: 'IMPORT_LINK_UNREADABLE' },
          });
          expect(requests).toHaveLength(0);
          expect(await draftRows()).toHaveLength(0);
        },
      );

      it('counts the fetch against the 75 seconds', async () => {
        const deadline = new AbortController();
        const timeout = vi
          .spyOn(AbortSignal, 'timeout')
          .mockReturnValue(deadline.signal);
        let fetching = false;
        const fetchPage: PageFetcher = (_url, signal) =>
          new Promise((_resolve, reject) => {
            fetching = true;
            signal.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
          });
        const { reader, requests } = spyReader();
        try {
          const pending = createCaller(
            makeContext({ reader, fetchPage }),
          ).recipeImports.start({ input: { kind: 'link', url: LINK } });
          await vi.waitFor(() => {
            expect(fetching).toBe(true);
          });
          deadline.abort();
          await expect(pending).rejects.toMatchObject({
            code: 'GATEWAY_TIMEOUT',
            cause: { code: 'IMPORT_TRY_AGAIN', reason: 'timeout' },
          });
          expect(timeout).toHaveBeenCalledTimes(1);
          expect(timeout).toHaveBeenCalledWith(RECIPE_IMPORT_TIMEOUT_MS);
        } finally {
          timeout.mockRestore();
        }
        expect(requests).toHaveLength(0);
        expect(await draftRows()).toHaveLength(0);
      });

      it('gives the reader what is left of the same 75 seconds', async () => {
        const { fetchPage, calls } = pageFetcher(JSON_LD_PAGE);
        const readSignals: AbortSignal[] = [];
        const inner = createFakeRecipeReader();
        const reader: RecipeReader = {
          ...inner,
          read: (request, signal) => {
            readSignals.push(signal);
            return inner.read(request, signal);
          },
        };
        await createCaller(
          makeContext({ reader, fetchPage }),
        ).recipeImports.start({ input: { kind: 'link', url: LINK } });

        expect(readSignals[0]).toBeDefined();
        expect(readSignals[0]).toBe(calls[0]?.signal);
      });

      it('imports the picked recipe from the same link', async () => {
        const { fetchPage, calls } = pageFetcher(
          `<html><body><main><p>${FAKE_READER_MARKERS.several} Menu</p></main></body></html>`,
        );
        const { reader, requests } = spyReader();
        const caller = createCaller(makeContext({ reader, fetchPage }));
        const input = { kind: 'link' as const, url: LINK };

        expect(await caller.recipeImports.start({ input })).toEqual({
          kind: 'several',
          names: ['Fake Soup', 'Fake Salad'],
        });
        const picked = await caller.recipeImports.start({
          input,
          pick: 'Fake Salad',
        });

        expect(picked.kind).toBe('draft');
        expect(calls).toHaveLength(2);
        expect(requests[1]?.input).toEqual(requests[0]?.input);
        expect(requests[1]?.pick).toBe('Fake Salad');
      });

      it("logs the link's host, never its path or the page", async () => {
        const lines: string[] = [];
        const log = pino(
          { level: 'info' },
          { write: (line) => lines.push(line) },
        );
        const { fetchPage } = pageFetcher(JSON_LD_PAGE);
        await createCaller(makeContext({ log, fetchPage })).recipeImports.start(
          { input: { kind: 'link', url: LINK } },
        );
        await expect(
          createCaller(
            makeContext({
              log,
              fetchPage: failingFetcher(new PageUnreadableError('status', 403))
                .fetchPage,
            }),
          ).recipeImports.start({ input: { kind: 'link', url: LINK } }),
        ).rejects.toBeDefined();

        const entries = lines
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((entry) => 'modelUsage' in entry);
        expect(entries[0]?.modelUsage).toMatchObject({
          inputKind: 'link',
          host: 'recipes.example',
          pageFormat: 'json_ld',
          pageTruncated: false,
          redirects: 0,
          outcome: 'draft',
        });
        expect(entries[0]?.modelUsage).toHaveProperty('fetchMs');
        expect(entries[1]?.modelUsage).toMatchObject({
          inputKind: 'link',
          host: 'recipes.example',
          outcome: 'IMPORT_LINK_UNREADABLE',
          reason: 'status',
          pageStatus: 403,
          inputTokens: null,
        });
        const output = lines.join('');
        expect(output).not.toContain('shakshuka');
        expect(output).not.toContain('utm_source');
        expect(output).not.toContain('olive oil');
      });
    });
  });

  async function insertManualDraft(): Promise<number> {
    const inserted = await db
      .insert(recipeDrafts)
      .values({
        userId: USER_ID,
        recipeId: null,
        draftData: { version: RECIPE_DRAFT_VERSION, fields: { name: 'X' } },
      })
      .returning({ id: recipeDrafts.id });
    const id = inserted[0]?.id;
    if (id === undefined) throw new Error('manual draft insert failed');
    return id;
  }

  describe('list, get and discard', () => {
    async function touch(draftId: number, isoTime: string): Promise<void> {
      await db
        .update(recipeDrafts)
        .set({ lastUpdatedAt: new Date(isoTime) })
        .where(eq(recipeDrafts.id, draftId));
    }

    it("lists the user's imports, newest first, and nothing else", async () => {
      const older = await startImport('Older Soup');
      const newer = await startImport('Newer Stew');
      await startImport('Their Pie', { userId: OTHER_USER_ID });
      await insertManualDraft();
      await touch(older, '2026-10-01T10:00:00Z');
      await touch(newer, '2026-10-02T10:00:00Z');

      const list = await createCaller(makeContext()).recipeImports.list();
      expect(list).toEqual([
        {
          id: newer,
          name: 'Newer Stew',
          inputKind: 'text',
          lastUpdatedAt: Date.parse('2026-10-02T10:00:00Z'),
        },
        {
          id: older,
          name: 'Older Soup',
          inputKind: 'text',
          lastUpdatedAt: Date.parse('2026-10-01T10:00:00Z'),
        },
      ]);
    });

    it('gets an import with its proposal and the editor fields', async () => {
      const draftId = await startImport();
      const result = await createCaller(makeContext()).recipeImports.get({
        draftId,
      });
      expect(result.id).toBe(draftId);
      expect(result.proposal?.header.name).toBe('Tomato Soup');
      expect(result.draftData.version).toBe(RECIPE_DRAFT_VERSION);
    });

    it('still lists and gets an import whose proposal is gone', async () => {
      const draftId = await startImport();
      await createCaller(makeContext()).recipeDrafts.upsert({
        draftId,
        recipeId: null,
        draftData: {
          version: RECIPE_DRAFT_VERSION,
          fields: { name: 'Edited' },
        },
      });
      const caller = createCaller(makeContext());
      expect((await caller.recipeImports.get({ draftId })).proposal).toBeNull();
      expect((await caller.recipeImports.list())[0]).toMatchObject({
        id: draftId,
        name: null,
        inputKind: null,
      });
    });

    it("doesn't get another user's import or a manual draft", async () => {
      const theirs = await startImport(RECIPE_TEXT, { userId: OTHER_USER_ID });
      const manual = await insertManualDraft();
      const caller = createCaller(makeContext());
      await expect(
        caller.recipeImports.get({ draftId: theirs }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        caller.recipeImports.get({ draftId: manual }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('discards only its own imports, leaving manual drafts alone', async () => {
      const mine = await startImport();
      const theirs = await startImport(RECIPE_TEXT, { userId: OTHER_USER_ID });
      const manual = await insertManualDraft();
      const caller = createCaller(makeContext());

      expect(await caller.recipeImports.discard({ draftId: theirs })).toEqual({
        deleted: false,
      });
      expect(await caller.recipeImports.discard({ draftId: manual })).toEqual({
        deleted: false,
      });
      expect(await caller.recipeImports.discard({ draftId: mine })).toEqual({
        deleted: true,
      });

      const remaining = (await draftRows()).map((row) => row.id);
      expect(remaining).toEqual([theirs, manual]);
    });

    it('lists and gets an image import with its images in page order', async () => {
      const draftId = await startImageImport([PAGE_2, PAGE_1]);
      const caller = createCaller(makeContext());

      expect((await caller.recipeImports.list())[0]).toMatchObject({
        id: draftId,
        inputKind: 'images',
      });
      expect((await caller.recipeImports.get({ draftId })).images).toEqual([
        { url: `${IMPORT_URL_PREFIX}${PAGE_2}` },
        { url: `${IMPORT_URL_PREFIX}${PAGE_1}` },
      ]);
    });

    it('gets a text import with no images', async () => {
      const draftId = await startImport();
      const result = await createCaller(makeContext()).recipeImports.get({
        draftId,
      });
      expect(result.images).toEqual([]);
    });

    it("deletes a discarded import's images from Cloudinary", async () => {
      const draftId = await startImageImport();
      const { destroyImage, destroyed } = destroySpy();

      const result = await createCaller(
        makeContext({ destroyImage }),
      ).recipeImports.discard({ draftId });

      expect(result).toEqual({ deleted: true });
      expect(destroyed).toEqual([PAGE_1, PAGE_2]);
      expect(await draftRows()).toHaveLength(0);
    });

    it('discards an import even when Cloudinary fails, and logs it', async () => {
      const draftId = await startImageImport();
      const { destroyImage, destroyed } = destroySpy([PAGE_1]);
      const lines: string[] = [];
      const log = pino(
        { level: 'info' },
        { write: (line) => lines.push(line) },
      );

      const result = await createCaller(
        makeContext({ destroyImage, log }),
      ).recipeImports.discard({ draftId });

      expect(result).toEqual({ deleted: true });
      expect(destroyed).toEqual([PAGE_1, PAGE_2]);
      expect(await draftRows()).toHaveLength(0);
      const warning = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find(
          (entry) => entry.msg === 'Import image not deleted from Cloudinary',
        );
      expect(warning).toMatchObject({ level: 40, publicId: PAGE_1 });
    });

    it('destroys nothing for a text import or an import that is not theirs', async () => {
      const text = await startImport();
      const theirs = await startImageImport([PAGE_1], {
        userId: OTHER_USER_ID,
      });
      const { destroyImage, destroyed } = destroySpy();
      const caller = createCaller(makeContext({ destroyImage }));

      await caller.recipeImports.discard({ draftId: text });
      await caller.recipeImports.discard({ draftId: theirs });

      expect(destroyed).toEqual([]);
    });

    it('never destroys an image a saved recipe keeps as an Original', async () => {
      const [recipe] = await db
        .insert(recipes)
        .values({
          householdId: CURRENT_HOUSEHOLD_ID,
          name: 'Kept',
          baseServings: 2,
        })
        .returning({ id: recipes.id });
      if (!recipe) throw new Error('recipe seed failed');
      await db
        .insert(recipeImportOriginals)
        .values({ recipeId: recipe.id, position: 0, publicId: PAGE_1 });
      // The cook's autosave can send any ids back in the proposal.
      const draftId = await startImageImport([PAGE_1, PAGE_2]);
      const { destroyImage, destroyed } = destroySpy();

      await createCaller(makeContext({ destroyImage })).recipeImports.discard({
        draftId,
      });

      expect(destroyed).toEqual([PAGE_2]);
    });
  });

  describe('createRecipe', () => {
    function createInput(
      draftId: number,
      overrides: Partial<CreateRecipeFromImportInput> = {},
    ): CreateRecipeFromImportInput {
      return {
        draftId,
        header: {
          name: 'Tomato Soup',
          description: null,
          imageUrl: null,
          baseServings: 4,
          activeTimeMins: 10,
          totalTimeMins: 30,
          estimatedCostPerServing: '1.20',
          sourceUrl: null,
          sourceDetail: 'p. 12',
          caloriesPerServing: 210,
          proteinPerServing: null,
          carbsPerServing: null,
          fatPerServing: null,
          saturatedFatPerServing: null,
          fibrePerServing: null,
          sugarPerServing: null,
          saltPerServing: 1.2,
          nutritionIsEstimated: true,
        },
        source: { newName: 'Ottolenghi Simple' },
        newIngredients: [
          {
            key: 'n1',
            name: 'basil',
            categoryId,
            defaultUnitId: unitG,
            isPlant: true,
            averageShelfLifeDays: 5,
          },
          {
            key: 'n2',
            name: 'Unused Thing',
            categoryId,
            defaultUnitId: unitG,
            isPlant: false,
            averageShelfLifeDays: null,
          },
        ],
        lines: [
          {
            ingredient: { id: oliveOilId, unitId: unitMl },
            quantity: '30',
            prepTypeId: null,
            isOptional: false,
          },
          {
            ingredient: { newKey: 'n1' },
            quantity: '10',
            prepTypeId: prepChopped,
            isOptional: true,
          },
        ],
        steps: [
          {
            instruction: 'Fry the oil and basil.',
            safetyNote: null,
            tip: 'Low heat.',
            prepAhead: null,
            ingredients: [
              { ingredient: { id: oliveOilId }, quantity: '15' },
              { ingredient: { newKey: 'n1' }, quantity: null },
            ],
          },
        ],
        tagNames: ['Vegetarian', 'Quick'],
        ...overrides,
      };
    }

    async function householdIngredientNames(): Promise<string[]> {
      const rows = await db
        .select({ name: ingredients.name })
        .from(ingredients)
        .where(eq(ingredients.householdId, CURRENT_HOUSEHOLD_ID))
        .orderBy(asc(ingredients.name));
      return rows.map((row) => row.name);
    }

    async function householdSourceNames(): Promise<string[]> {
      const rows = await db
        .select({ name: recipeSources.name })
        .from(recipeSources)
        .where(eq(recipeSources.householdId, CURRENT_HOUSEHOLD_ID))
        .orderBy(asc(recipeSources.name));
      return rows.map((row) => row.name);
    }

    async function expectNothingCreated(draftId: number): Promise<void> {
      expect(await db.select().from(recipes)).toHaveLength(0);
      expect(await householdIngredientNames()).toEqual(['Olive Oil', 'Onion']);
      expect(await householdSourceNames()).toEqual(['BBC Good Food']);
      const tagRows = await db
        .select({ name: recipeTags.name })
        .from(recipeTags)
        .where(eq(recipeTags.householdId, CURRENT_HOUSEHOLD_ID));
      expect(tagRows.map((row) => row.name)).toEqual(['Vegetarian']);
      expect((await draftRows()).map((row) => row.id)).toEqual([draftId]);
    }

    it('writes the recipe and everything new it needs, then deletes the draft', async () => {
      const draftId = await startImport();
      const caller = createCaller(makeContext());
      const { recipeId } = await caller.recipeImports.createRecipe(
        createInput(draftId),
      );

      const [recipe] = await db
        .select()
        .from(recipes)
        .where(eq(recipes.id, recipeId));
      const [source] = await db
        .select()
        .from(recipeSources)
        .where(eq(recipeSources.name, 'Ottolenghi Simple'));
      expect(source?.householdId).toBe(CURRENT_HOUSEHOLD_ID);
      expect(recipe).toMatchObject({
        householdId: CURRENT_HOUSEHOLD_ID,
        addedByUserId: USER_ID,
        name: 'Tomato Soup',
        baseServings: 4,
        estimatedCostPerServing: '1.20',
        sourceId: source?.id,
        sourceDetail: 'p. 12',
        caloriesPerServing: 210,
        saltPerServing: 1.2,
        nutritionIsEstimated: true,
        isBase: false,
        baseRecipeId: null,
      });

      const [basil] = await db
        .select()
        .from(ingredients)
        .where(eq(ingredients.name, 'Basil'));
      expect(basil).toMatchObject({
        householdId: CURRENT_HOUSEHOLD_ID,
        categoryId,
        defaultUnitId: unitG,
        isPlant: true,
        averageShelfLifeDays: 5,
      });
      expect(await householdIngredientNames()).toEqual([
        'Basil',
        'Olive Oil',
        'Onion',
      ]);

      const detail = await caller.recipes.get({ id: recipeId });
      expect(
        detail.ingredients.map((line) => ({
          ingredientId: line.ingredientId,
          quantity: line.quantity,
          prepTypeId: line.prepTypeId,
          isOptional: line.isOptional,
        })),
      ).toEqual([
        {
          ingredientId: oliveOilId,
          quantity: '30.000',
          prepTypeId: null,
          isOptional: false,
        },
        {
          ingredientId: basil?.id,
          quantity: '10.000',
          prepTypeId: prepChopped,
          isOptional: true,
        },
      ]);
      expect(detail.method).toMatchObject([
        {
          instruction: 'Fry the oil and basil.',
          tip: 'Low heat.',
          ingredients: expect.arrayContaining([
            { ingredientId: oliveOilId, quantity: '15.000' },
            { ingredientId: basil?.id, quantity: null },
          ]) as unknown,
        },
      ]);
      expect(detail.tags.map((tag) => tag.name).sort()).toEqual([
        'Quick',
        'Vegetarian',
      ]);
      expect(await draftRows()).toHaveLength(0);
    });

    it('links a proposed source that exists by now', async () => {
      const draftId = await startImport();
      const [existing] = await db
        .insert(recipeSources)
        .values({
          householdId: CURRENT_HOUSEHOLD_ID,
          name: 'Ottolenghi Simple',
        })
        .returning();
      const { recipeId } = await createCaller(
        makeContext(),
      ).recipeImports.createRecipe(
        createInput(draftId, { source: { newName: 'ottolenghi simple' } }),
      );
      const [recipe] = await db
        .select({ sourceId: recipes.sourceId })
        .from(recipes)
        .where(eq(recipes.id, recipeId));
      expect(recipe?.sourceId).toBe(existing?.id);
      expect(await householdSourceNames()).toEqual([
        'BBC Good Food',
        'Ottolenghi Simple',
      ]);
    });

    it('gives INGREDIENT_NAME_TAKEN for a name taken since the import, and creates nothing', async () => {
      const draftId = await startImport();
      await db.insert(ingredients).values({
        householdId: CURRENT_HOUSEHOLD_ID,
        name: 'Basil',
        categoryId,
        defaultUnitId: unitG,
        isPlant: true,
      });
      await expect(
        createCaller(makeContext()).recipeImports.createRecipe(
          createInput(draftId),
        ),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        cause: { code: 'INGREDIENT_NAME_TAKEN', newKey: 'n1' },
      });
      expect(await db.select().from(recipes)).toHaveLength(0);
      expect(await householdSourceNames()).toEqual(['BBC Good Food']);
      expect((await draftRows()).map((row) => row.id)).toEqual([draftId]);
    });

    it('leaves nothing behind when a write fails partway', async () => {
      const draftId = await startImport();
      // A NOT VALID check rejects every new tag link, so the failure lands
      // after the source, ingredients, recipe, lines and method are written.
      await db.execute(
        sql`alter table recipe_tag_links add constraint block_new_links check (tag_id < 0) not valid`,
      );
      try {
        await expect(
          createCaller(makeContext()).recipeImports.createRecipe(
            createInput(draftId),
          ),
        ).rejects.toBeDefined();
      } finally {
        await db.execute(
          sql`alter table recipe_tag_links drop constraint block_new_links`,
        );
      }
      await expectNothingCreated(draftId);
    });

    it('creates the recipe once when sent twice at the same time', async () => {
      const draftId = await startImport();
      const caller = createCaller(makeContext());
      const results = await Promise.allSettled([
        caller.recipeImports.createRecipe(createInput(draftId)),
        caller.recipeImports.createRecipe(createInput(draftId)),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([
        'fulfilled',
        'rejected',
      ]);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected?.reason).toMatchObject({ code: 'NOT_FOUND' });
      expect(await db.select().from(recipes)).toHaveLength(1);
    });

    it("refuses another user's import and a manual draft", async () => {
      const theirs = await startImport(RECIPE_TEXT, { userId: OTHER_USER_ID });
      const manual = await insertManualDraft();
      const caller = createCaller(makeContext());
      await expect(
        caller.recipeImports.createRecipe(createInput(theirs)),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        caller.recipeImports.createRecipe(createInput(manual)),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await db.select().from(recipes)).toHaveLength(0);
      expect((await draftRows()).map((row) => row.id)).toEqual([
        theirs,
        manual,
      ]);
    });

    it('refuses a line in a unit other than the ingredient’s own', async () => {
      const draftId = await startImport();
      const input = createInput(draftId);
      input.lines[0] = {
        ingredient: { id: oliveOilId, unitId: unitG },
        quantity: '30',
        prepTypeId: null,
        isOptional: false,
      };
      await expect(
        createCaller(makeContext()).recipeImports.createRecipe(input),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'RECIPE_INGREDIENT_UNIT_MISMATCH' },
      });
      await expectNothingCreated(draftId);
    });

    it("refuses another household's ingredient", async () => {
      const draftId = await startImport();
      const input = createInput(draftId);
      const step = input.steps[0];
      if (!step) throw new Error('fixture');
      step.ingredients = [{ ingredient: { id: outsiderId }, quantity: null }];
      await expect(
        createCaller(makeContext()).recipeImports.createRecipe(input),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: {
          code: 'RECIPE_INGREDIENT_NOT_FOUND',
          ingredientId: outsiderId,
        },
      });
    });

    it('refuses step amounts over the lines being created', async () => {
      const draftId = await startImport();
      const input = createInput(draftId);
      const step = input.steps[0];
      if (!step) throw new Error('fixture');
      step.ingredients = [{ ingredient: { newKey: 'n1' }, quantity: '25' }];
      await expect(
        createCaller(makeContext()).recipeImports.createRecipe(input),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: {
          code: 'RECIPE_STEP_AMOUNT_EXCEEDS_TOTAL',
          newKey: 'n1',
          stated: 25,
          total: 10,
        },
      });
    });

    it('rejects a reference to a new ingredient it was not sent', async () => {
      const draftId = await startImport();
      const input = createInput(draftId);
      input.lines.push({
        ingredient: { newKey: 'n9' },
        quantity: '1',
        prepTypeId: null,
        isOptional: false,
      });
      await expect(
        createCaller(makeContext()).recipeImports.createRecipe(input),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it("keeps an image import's images as Originals in page order, never as the recipe image", async () => {
      const draftId = await startImageImport([PAGE_2, PAGE_1]);
      const { destroyImage, destroyed } = destroySpy();
      const caller = createCaller(makeContext({ destroyImage }));

      const { recipeId } = await caller.recipeImports.createRecipe(
        createInput(draftId),
      );

      const originals = await db
        .select()
        .from(recipeImportOriginals)
        .orderBy(asc(recipeImportOriginals.position));
      expect(
        originals.map(({ recipeId: id, position, publicId }) => ({
          id,
          position,
          publicId,
        })),
      ).toEqual([
        { id: recipeId, position: 0, publicId: PAGE_2 },
        { id: recipeId, position: 1, publicId: PAGE_1 },
      ]);
      const recipe = await caller.recipes.get({ id: recipeId });
      expect(recipe.imageUrl).toBeNull();
      expect(recipe.originals).toEqual([
        { url: `${IMPORT_URL_PREFIX}${PAGE_2}` },
        { url: `${IMPORT_URL_PREFIX}${PAGE_1}` },
      ]);
      expect(destroyed).toEqual([]);
    });

    it('keeps Originals through soft delete and restore', async () => {
      const draftId = await startImageImport([PAGE_1]);
      const caller = createCaller(makeContext());
      const { recipeId } = await caller.recipeImports.createRecipe(
        createInput(draftId),
      );

      await caller.recipes.softDelete({ id: recipeId });
      expect((await caller.recipes.get({ id: recipeId })).originals).toEqual([
        { url: `${IMPORT_URL_PREFIX}${PAGE_1}` },
      ]);
      await caller.recipes.restore({ id: recipeId });
      expect((await caller.recipes.get({ id: recipeId })).originals).toEqual([
        { url: `${IMPORT_URL_PREFIX}${PAGE_1}` },
      ]);
    });

    it('keeps no Originals for a text import', async () => {
      const draftId = await startImport();
      const caller = createCaller(makeContext());
      const { recipeId } = await caller.recipeImports.createRecipe(
        createInput(draftId),
      );

      expect(await db.select().from(recipeImportOriginals)).toHaveLength(0);
      expect((await caller.recipes.get({ id: recipeId })).originals).toEqual(
        [],
      );
    });

    it('rolls the whole recipe back when an Original cannot be written', async () => {
      const [kept] = await db
        .insert(recipes)
        .values({
          householdId: CURRENT_HOUSEHOLD_ID,
          name: 'Kept',
          baseServings: 2,
        })
        .returning({ id: recipes.id });
      if (!kept) throw new Error('recipe seed failed');
      await db
        .insert(recipeImportOriginals)
        .values({ recipeId: kept.id, position: 0, publicId: PAGE_2 });
      const draftId = await startImageImport([PAGE_1, PAGE_2]);

      await expect(
        createCaller(makeContext()).recipeImports.createRecipe(
          createInput(draftId),
        ),
      ).rejects.toBeDefined();

      const recipeNames = (await db.select().from(recipes)).map(
        (row) => row.name,
      );
      expect(recipeNames).toEqual(['Kept']);
      expect(await householdSourceNames()).toEqual(['BBC Good Food']);
      expect(await db.select().from(recipeImportOriginals)).toHaveLength(1);
      expect((await draftRows()).map((row) => row.id)).toEqual([draftId]);
    });
  });
});
