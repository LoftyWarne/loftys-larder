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
import {
  createFakeRecipeReader,
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

    it('rejects unauthenticated callers', async () => {
      const caller = createCaller(makeContext({ authenticated: false }));
      await expect(
        caller.recipeImports.start({
          input: { kind: 'text', text: RECIPE_TEXT },
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
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
  });
});
