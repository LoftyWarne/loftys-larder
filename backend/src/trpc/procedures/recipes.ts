import { TRPCError } from '@trpc/server';
import { and, asc, avg, eq, or, sql } from 'drizzle-orm';

import {
  getRecipeInputSchema,
  listRecipesInputSchema,
  listRecipesResultSchema,
  recipeSchema,
  type ListRecipesResult,
  type Recipe,
} from '../../../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../../config.ts';
import type { Db } from '../../db/index.ts';
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
});

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
