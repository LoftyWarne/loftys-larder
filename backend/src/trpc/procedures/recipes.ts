import { TRPCError } from '@trpc/server';
import { and, asc, avg, eq, inArray, or, sql } from 'drizzle-orm';

import {
  createRecipeInputSchema,
  createRecipeResultSchema,
  getRecipeInputSchema,
  listRecipesInputSchema,
  listRecipesResultSchema,
  recipeSchema,
  replaceRecipeIngredientsInputSchema,
  replaceRecipeIngredientsResultSchema,
  replaceRecipeMethodInputSchema,
  replaceRecipeMethodResultSchema,
  setRecipeDeletionInputSchema,
  setRecipeDeletionResultSchema,
  updateRecipeHeaderInputSchema,
  updateRecipeHeaderResultSchema,
  type CreateRecipeResult,
  type DomainErrorCode,
  type ListRecipesResult,
  type Recipe,
  type ReplaceRecipeIngredientsResult,
  type ReplaceRecipeMethodResult,
  type SetRecipeDeletionResult,
  type UpdateRecipeHeaderResult,
} from '../../../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../../config.ts';
import type { Db } from '../../db/index.ts';
import { makeWithTransaction } from '../../db/withTransaction.ts';
import { ingredients } from '../../db/schema/ingredients.ts';
import {
  preparationTypes,
  unitsOfMeasurement,
} from '../../db/schema/reference.ts';
import { recipeRatings } from '../../db/schema/recipe-social.ts';
import {
  recipeIngredients,
  recipeMethod,
  recipeSources,
  recipes,
} from '../../db/schema/recipes.ts';
import {
  pickableRecipesWhere,
  type PickableRecipesOptions,
} from '../../lib/pickable-recipes.ts';
import { recipePlantPointsExpr } from '../../lib/plant-points.ts';
import { protectedProcedure, router } from '../init.ts';

const DEFAULT_LIST_LIMIT = 30;

export const recipesRouter = router({
  list: protectedProcedure
    .input(listRecipesInputSchema)
    .output(listRecipesResultSchema)
    .query(async ({ ctx, input }): Promise<ListRecipesResult> => {
      const limit = input?.limit ?? DEFAULT_LIST_LIMIT;
      const pickerOptions: PickableRecipesOptions = {
        includeDeleted: input?.includeDeleted,
        includePickerHidden: input?.includePickerHidden,
      };

      const conditions = [pickableRecipesWhere(pickerOptions)];

      const search = input?.search?.trim();
      if (search) {
        const lowered = search.toLowerCase();
        conditions.push(sql`lower(${recipes.name}) like ${`%${lowered}%`}`);
      }

      // Keyset pagination on (lower(name), id). Compare by `lower(name)` for
      // deterministic ordering identical to the ORDER BY clause; ties broken
      // by id.
      const cursor = input?.cursor;
      if (cursor) {
        const cursorName = cursor.lowerName;
        const cursorId = cursor.id;
        const cursorCondition = or(
          sql`lower(${recipes.name}) > ${cursorName}`,
          and(
            sql`lower(${recipes.name}) = ${cursorName}`,
            sql`${recipes.id} > ${cursorId}`,
          ),
        );
        if (cursorCondition) conditions.push(cursorCondition);
      }

      // Fetch limit + 1 to learn whether more pages exist without a second
      // count query.
      const rows = await ctx.db
        .select({
          id: recipes.id,
          name: recipes.name,
          imageUrl: recipes.imageUrl,
          baseServings: recipes.baseServings,
          activeTimeMins: recipes.activeTimeMins,
          totalTimeMins: recipes.totalTimeMins,
          isBase: recipes.isBase,
          baseRecipeId: recipes.baseRecipeId,
          pairedRecipeId: recipes.pairedRecipeId,
          isDeleted: recipes.isDeleted,
          plantPointsCount: recipePlantPointsExpr(sql`recipes.id`),
        })
        .from(recipes)
        .where(and(...conditions))
        .orderBy(asc(sql`lower(${recipes.name})`), asc(recipes.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last
          ? { lowerName: last.name.toLowerCase(), id: last.id }
          : null;

      return {
        items: page.map((row) => ({
          id: row.id,
          name: row.name,
          imageUrl: row.imageUrl,
          baseServings: row.baseServings,
          activeTimeMins: row.activeTimeMins,
          totalTimeMins: row.totalTimeMins,
          isBase: row.isBase,
          baseRecipeId: row.baseRecipeId,
          pairedRecipeId: row.pairedRecipeId,
          isDeleted: row.isDeleted,
          plantPointsCount: row.plantPointsCount,
        })),
        nextCursor,
      };
    }),

  get: protectedProcedure
    .input(getRecipeInputSchema)
    .output(recipeSchema)
    .query(async ({ ctx, input }): Promise<Recipe> => {
      const userId = ctx.user.id;
      const recipeId = input.id;

      // Four parallel queries — header+source, ingredients (joined),
      // ordered method, ratings aggregate including the caller's own row.
      // Soft-deleted recipes are returned (DEC-21).
      const [headerRows, ingredientRows, methodRows, ratingRow] =
        await Promise.all([
          ctx.db
            .select({
              id: recipes.id,
              name: recipes.name,
              description: recipes.description,
              imageUrl: recipes.imageUrl,
              baseServings: recipes.baseServings,
              activeTimeMins: recipes.activeTimeMins,
              totalTimeMins: recipes.totalTimeMins,
              estimatedCostPerServing: recipes.estimatedCostPerServing,
              sourceId: recipes.sourceId,
              sourceUrl: recipes.sourceUrl,
              sourceName: recipeSources.name,
              caloriesPerServing: recipes.caloriesPerServing,
              proteinPerServing: recipes.proteinPerServing,
              carbsPerServing: recipes.carbsPerServing,
              fatPerServing: recipes.fatPerServing,
              saturatedFatPerServing: recipes.saturatedFatPerServing,
              fibrePerServing: recipes.fibrePerServing,
              sugarPerServing: recipes.sugarPerServing,
              saltPerServing: recipes.saltPerServing,
              addedByUserId: recipes.addedByUserId,
              isBase: recipes.isBase,
              baseRecipeId: recipes.baseRecipeId,
              pairedRecipeId: recipes.pairedRecipeId,
              isDeleted: recipes.isDeleted,
              plantPointsCount: recipePlantPointsExpr(sql`recipes.id`),
            })
            .from(recipes)
            .leftJoin(recipeSources, eq(recipes.sourceId, recipeSources.id))
            .where(
              and(
                eq(recipes.id, recipeId),
                eq(recipes.householdId, CURRENT_HOUSEHOLD_ID),
              ),
            )
            .limit(1),
          loadIngredientLines(ctx.db, recipeId),
          ctx.db
            .select({
              id: recipeMethod.id,
              stepNumber: recipeMethod.stepNumber,
              instruction: recipeMethod.instruction,
            })
            .from(recipeMethod)
            .where(eq(recipeMethod.recipeId, recipeId))
            .orderBy(asc(recipeMethod.stepNumber)),
          loadRatingAggregate(ctx.db, recipeId, userId),
        ]);

      const header = headerRows[0];
      if (!header) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Recipe not found',
        });
      }

      return {
        id: header.id,
        name: header.name,
        description: header.description,
        imageUrl: header.imageUrl,
        baseServings: header.baseServings,
        activeTimeMins: header.activeTimeMins,
        totalTimeMins: header.totalTimeMins,
        estimatedCostPerServing: header.estimatedCostPerServing,
        sourceId: header.sourceId,
        sourceName: header.sourceName,
        sourceUrl: header.sourceUrl,
        caloriesPerServing: header.caloriesPerServing,
        proteinPerServing: header.proteinPerServing,
        carbsPerServing: header.carbsPerServing,
        fatPerServing: header.fatPerServing,
        saturatedFatPerServing: header.saturatedFatPerServing,
        fibrePerServing: header.fibrePerServing,
        sugarPerServing: header.sugarPerServing,
        saltPerServing: header.saltPerServing,
        addedByUserId: header.addedByUserId,
        isBase: header.isBase,
        baseRecipeId: header.baseRecipeId,
        pairedRecipeId: header.pairedRecipeId,
        isDeleted: header.isDeleted,
        plantPointsCount: header.plantPointsCount,
        ingredients: ingredientRows,
        method: methodRows,
        averageRating: ratingRow.averageRating,
        ratingCount: ratingRow.ratingCount,
        yourRating: ratingRow.yourRating,
      };
    }),

  create: protectedProcedure
    .input(createRecipeInputSchema)
    .output(createRecipeResultSchema)
    .mutation(async ({ ctx, input }): Promise<CreateRecipeResult> => {
      const inserted = await ctx.db
        .insert(recipes)
        .values({
          householdId: CURRENT_HOUSEHOLD_ID,
          name: input.name,
          description: input.description,
          imageUrl: input.imageUrl,
          baseServings: input.baseServings,
          activeTimeMins: input.activeTimeMins,
          totalTimeMins: input.totalTimeMins,
          estimatedCostPerServing: input.estimatedCostPerServing,
          sourceId: input.sourceId,
          sourceUrl: input.sourceUrl,
          caloriesPerServing: input.caloriesPerServing,
          proteinPerServing: input.proteinPerServing,
          carbsPerServing: input.carbsPerServing,
          fatPerServing: input.fatPerServing,
          saturatedFatPerServing: input.saturatedFatPerServing,
          fibrePerServing: input.fibrePerServing,
          sugarPerServing: input.sugarPerServing,
          saltPerServing: input.saltPerServing,
          isBase: input.isBase ?? false,
          addedByUserId: ctx.user.id,
        })
        .returning({ id: recipes.id });
      const row = inserted[0];
      if (!row) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Insert returned no row',
        });
      }
      return { id: row.id };
    }),

  updateHeader: protectedProcedure
    .input(updateRecipeHeaderInputSchema)
    .output(updateRecipeHeaderResultSchema)
    .mutation(async ({ ctx, input }): Promise<UpdateRecipeHeaderResult> => {
      const { id, patch } = input;

      const patchValues: Partial<typeof recipes.$inferInsert> = {};
      if (patch.name !== undefined) patchValues.name = patch.name;
      if (patch.description !== undefined)
        patchValues.description = patch.description;
      if (patch.imageUrl !== undefined) patchValues.imageUrl = patch.imageUrl;
      if (patch.baseServings !== undefined)
        patchValues.baseServings = patch.baseServings;
      if (patch.activeTimeMins !== undefined)
        patchValues.activeTimeMins = patch.activeTimeMins;
      if (patch.totalTimeMins !== undefined)
        patchValues.totalTimeMins = patch.totalTimeMins;
      if (patch.estimatedCostPerServing !== undefined)
        patchValues.estimatedCostPerServing = patch.estimatedCostPerServing;
      if (patch.sourceId !== undefined) patchValues.sourceId = patch.sourceId;
      if (patch.sourceUrl !== undefined)
        patchValues.sourceUrl = patch.sourceUrl;
      if (patch.caloriesPerServing !== undefined)
        patchValues.caloriesPerServing = patch.caloriesPerServing;
      if (patch.proteinPerServing !== undefined)
        patchValues.proteinPerServing = patch.proteinPerServing;
      if (patch.carbsPerServing !== undefined)
        patchValues.carbsPerServing = patch.carbsPerServing;
      if (patch.fatPerServing !== undefined)
        patchValues.fatPerServing = patch.fatPerServing;
      if (patch.saturatedFatPerServing !== undefined)
        patchValues.saturatedFatPerServing = patch.saturatedFatPerServing;
      if (patch.fibrePerServing !== undefined)
        patchValues.fibrePerServing = patch.fibrePerServing;
      if (patch.sugarPerServing !== undefined)
        patchValues.sugarPerServing = patch.sugarPerServing;
      if (patch.saltPerServing !== undefined)
        patchValues.saltPerServing = patch.saltPerServing;

      const updated = await ctx.db
        .update(recipes)
        .set(patchValues)
        .where(
          and(
            eq(recipes.id, id),
            eq(recipes.householdId, CURRENT_HOUSEHOLD_ID),
          ),
        )
        .returning({ id: recipes.id });

      const row = updated[0];
      if (!row) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Recipe not found',
        });
      }
      return { id: row.id };
    }),

  replaceIngredients: protectedProcedure
    .input(replaceRecipeIngredientsInputSchema)
    .output(replaceRecipeIngredientsResultSchema)
    .mutation(
      async ({ ctx, input }): Promise<ReplaceRecipeIngredientsResult> => {
        await assertRecipeInHousehold(ctx.db, input.recipeId);

        // Validate every line's ingredient + unit against household state
        // before opening a transaction. A pre-flight lookup is cheaper than
        // round-tripping each FK / unit check inside the write path, and the
        // error messages are richer (we can name the offending line).
        if (input.lines.length > 0) {
          const ingredientIds = Array.from(
            new Set(input.lines.map((line) => line.ingredientId)),
          );
          const ingredientRows = await ctx.db
            .select({
              id: ingredients.id,
              defaultUnitId: ingredients.defaultUnitId,
            })
            .from(ingredients)
            .where(
              and(
                inArray(ingredients.id, ingredientIds),
                eq(ingredients.householdId, CURRENT_HOUSEHOLD_ID),
              ),
            );
          const byId = new Map(ingredientRows.map((r) => [r.id, r]));

          for (const line of input.lines) {
            const ingredient = byId.get(line.ingredientId);
            if (!ingredient) {
              throw domainBadRequest(
                'RECIPE_INGREDIENT_NOT_FOUND',
                'One or more ingredients are not available to this household',
                { ingredientId: line.ingredientId },
              );
            }
            if (ingredient.defaultUnitId !== line.unitId) {
              throw domainBadRequest(
                'RECIPE_INGREDIENT_UNIT_MISMATCH',
                'Ingredient unit does not match its enforced unit',
                {
                  ingredientId: line.ingredientId,
                  expectedUnitId: ingredient.defaultUnitId,
                  providedUnitId: line.unitId,
                },
              );
            }
          }
        }

        const withTransaction = makeWithTransaction(ctx.db);
        await withTransaction(async (tx) => {
          await tx
            .delete(recipeIngredients)
            .where(eq(recipeIngredients.recipeId, input.recipeId));
          if (input.lines.length > 0) {
            await tx.insert(recipeIngredients).values(
              input.lines.map((line) => ({
                recipeId: input.recipeId,
                ingredientId: line.ingredientId,
                quantity: line.quantity,
                prepTypeId: line.prepTypeId,
              })),
            );
          }
        });

        return { recipeId: input.recipeId, count: input.lines.length };
      },
    ),

  replaceMethod: protectedProcedure
    .input(replaceRecipeMethodInputSchema)
    .output(replaceRecipeMethodResultSchema)
    .mutation(async ({ ctx, input }): Promise<ReplaceRecipeMethodResult> => {
      await assertRecipeInHousehold(ctx.db, input.recipeId);

      const withTransaction = makeWithTransaction(ctx.db);
      await withTransaction(async (tx) => {
        await tx
          .delete(recipeMethod)
          .where(eq(recipeMethod.recipeId, input.recipeId));
        if (input.steps.length > 0) {
          // Numbering is authoritative server-side — the unique
          // `(recipe_id, step_number)` index would otherwise expose a footgun
          // if clients sent duplicate step numbers.
          await tx.insert(recipeMethod).values(
            input.steps.map((step, index) => ({
              recipeId: input.recipeId,
              stepNumber: index + 1,
              instruction: step.instruction,
            })),
          );
        }
      });

      return { recipeId: input.recipeId, count: input.steps.length };
    }),

  softDelete: protectedProcedure
    .input(setRecipeDeletionInputSchema)
    .output(setRecipeDeletionResultSchema)
    .mutation(async ({ ctx, input }): Promise<SetRecipeDeletionResult> => {
      return setRecipeDeletion(ctx.db, input.id, true);
    }),

  restore: protectedProcedure
    .input(setRecipeDeletionInputSchema)
    .output(setRecipeDeletionResultSchema)
    .mutation(async ({ ctx, input }): Promise<SetRecipeDeletionResult> => {
      return setRecipeDeletion(ctx.db, input.id, false);
    }),
});

function domainBadRequest(
  code: DomainErrorCode,
  message: string,
  metadata: Record<string, unknown> = {},
): TRPCError {
  return new TRPCError({
    code: 'BAD_REQUEST',
    message,
    cause: { code, ...metadata },
  });
}

async function assertRecipeInHousehold(
  db: Db,
  recipeId: number,
): Promise<void> {
  const rows = await db
    .select({ id: recipes.id })
    .from(recipes)
    .where(
      and(
        eq(recipes.id, recipeId),
        eq(recipes.householdId, CURRENT_HOUSEHOLD_ID),
      ),
    )
    .limit(1);
  if (rows.length === 0) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Recipe not found' });
  }
}

async function setRecipeDeletion(
  db: Db,
  recipeId: number,
  isDeleted: boolean,
): Promise<SetRecipeDeletionResult> {
  const updated = await db
    .update(recipes)
    .set({ isDeleted })
    .where(
      and(
        eq(recipes.id, recipeId),
        eq(recipes.householdId, CURRENT_HOUSEHOLD_ID),
      ),
    )
    .returning({ id: recipes.id, isDeleted: recipes.isDeleted });
  const row = updated[0];
  if (!row) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Recipe not found' });
  }
  return { id: row.id, isDeleted: row.isDeleted };
}

async function loadIngredientLines(
  db: Db,
  recipeId: number,
): Promise<Recipe['ingredients']> {
  const rows = await db
    .select({
      id: recipeIngredients.id,
      ingredientId: recipeIngredients.ingredientId,
      ingredientName: ingredients.name,
      quantity: recipeIngredients.quantity,
      unitId: ingredients.defaultUnitId,
      unitName: unitsOfMeasurement.name,
      prepTypeId: recipeIngredients.prepTypeId,
      prepTypeName: preparationTypes.name,
      isPlant: ingredients.isPlant,
    })
    .from(recipeIngredients)
    .innerJoin(ingredients, eq(ingredients.id, recipeIngredients.ingredientId))
    .innerJoin(
      unitsOfMeasurement,
      eq(unitsOfMeasurement.id, ingredients.defaultUnitId),
    )
    .leftJoin(
      preparationTypes,
      eq(preparationTypes.id, recipeIngredients.prepTypeId),
    )
    .where(eq(recipeIngredients.recipeId, recipeId))
    .orderBy(asc(recipeIngredients.id));
  return rows;
}

interface RatingAggregate {
  averageRating: number | null;
  ratingCount: number;
  yourRating: number | null;
}

async function loadRatingAggregate(
  db: Db,
  recipeId: number,
  userId: string,
): Promise<RatingAggregate> {
  const rows = await db
    .select({
      avg: avg(recipeRatings.rating),
      // ::int cast so the value comes back as a JS number (Postgres returns
      // count(*) as bigint -> string by default).
      count: sql<number>`count(${recipeRatings.id})::int`,
      yours: sql<
        number | null
      >`max(case when ${recipeRatings.userId} = ${userId} then ${recipeRatings.rating} end)`,
    })
    .from(recipeRatings)
    .where(eq(recipeRatings.recipeId, recipeId));
  const row = rows[0];
  if (!row) {
    return { averageRating: null, ratingCount: 0, yourRating: null };
  }
  return {
    averageRating: row.avg === null ? null : Number(row.avg),
    ratingCount: row.count,
    yourRating: row.yours,
  };
}
