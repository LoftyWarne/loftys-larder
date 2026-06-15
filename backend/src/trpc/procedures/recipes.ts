import { TRPCError } from '@trpc/server';
import { and, asc, avg, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import {
  addRecipeCommentInputSchema,
  addRecipeCommentResultSchema,
  addRelatedRecipeInputSchema,
  addRelatedRecipeResultSchema,
  createRecipeInputSchema,
  createRecipeResultSchema,
  deleteRecipeCommentInputSchema,
  deleteRecipeCommentResultSchema,
  editRecipeCommentInputSchema,
  editRecipeCommentResultSchema,
  getRecipeInputSchema,
  listRecipeCommentsInputSchema,
  listRecipeCommentsResultSchema,
  listRecipesInputSchema,
  listRecipesResultSchema,
  listRelatedRecipesInputSchema,
  listRelatedRecipesResultSchema,
  rateRecipeInputSchema,
  rateRecipeResultSchema,
  recipeReferencesSchema,
  recipeSchema,
  removeRelatedRecipeInputSchema,
  removeRelatedRecipeResultSchema,
  replaceRecipeIngredientsInputSchema,
  replaceRecipeIngredientsResultSchema,
  replaceRecipeMethodInputSchema,
  replaceRecipeMethodResultSchema,
  setRecipeBatchFieldsInputSchema,
  setRecipeBatchFieldsResultSchema,
  setRecipeDeletionInputSchema,
  setRecipeDeletionResultSchema,
  unrateRecipeInputSchema,
  unrateRecipeResultSchema,
  updateRecipeHeaderInputSchema,
  updateRecipeHeaderResultSchema,
  type AddRecipeCommentResult,
  type AddRelatedRecipeResult,
  type CreateRecipeResult,
  type DeleteRecipeCommentResult,
  type DomainErrorCode,
  type EditRecipeCommentResult,
  type ListRecipeCommentsResult,
  type ListRecipesResult,
  type ListRelatedRecipesResult,
  type RateRecipeResult,
  type Recipe,
  type RecipeReferences,
  type RemoveRelatedRecipeResult,
  type ReplaceRecipeIngredientsResult,
  type ReplaceRecipeMethodResult,
  type SetRecipeBatchFieldsResult,
  type SetRecipeDeletionResult,
  type UnrateRecipeResult,
  type UpdateRecipeHeaderResult,
} from '../../../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../../config.ts';
import type { Db } from '../../db/index.ts';
import { makeWithTransaction } from '../../db/withTransaction.ts';
import { users } from '../../db/schema/auth.ts';
import { ingredients } from '../../db/schema/ingredients.ts';
import {
  preparationTypes,
  unitsOfMeasurement,
} from '../../db/schema/reference.ts';
import {
  recipeComments,
  recipeRatings,
  relatedRecipes,
} from '../../db/schema/recipe-social.ts';
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
  references: protectedProcedure
    .output(recipeReferencesSchema)
    .query(async ({ ctx }): Promise<RecipeReferences> => {
      // Units + prep types are global reference tables; sources are scoped to
      // the current household (DEC-17). Three parallel reads — cheaper than
      // sequential and the result is the editor's picker payload.
      const [units, prepTypes, sources] = await Promise.all([
        ctx.db
          .select({ id: unitsOfMeasurement.id, name: unitsOfMeasurement.name })
          .from(unitsOfMeasurement)
          .orderBy(asc(unitsOfMeasurement.name)),
        ctx.db
          .select({ id: preparationTypes.id, name: preparationTypes.name })
          .from(preparationTypes)
          .orderBy(asc(preparationTypes.name)),
        ctx.db
          .select({ id: recipeSources.id, name: recipeSources.name })
          .from(recipeSources)
          .where(eq(recipeSources.householdId, CURRENT_HOUSEHOLD_ID))
          .orderBy(asc(recipeSources.name)),
      ]);
      return { units, prepTypes, sources };
    }),

  list: protectedProcedure
    .input(listRecipesInputSchema)
    .output(listRecipesResultSchema)
    .query(async ({ ctx, input }): Promise<ListRecipesResult> => {
      const limit = input?.limit ?? DEFAULT_LIST_LIMIT;
      const pickerOptions: PickableRecipesOptions = {
        includeDeleted: input?.includeDeleted,
        includePickerHidden: input?.includePickerHidden,
        isBase: input?.isBase,
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
      // count query. Rating aggregates are correlated scalar subqueries —
      // one indexed lookup per row on `(recipe_id)` against `recipe_ratings`,
      // null when the recipe has no ratings. Columns are spelled out as
      // `<table>.<column>` because `${column}` renders bare inside a `sql`
      // template and `recipe_ratings` also has its own `id`, which would
      // otherwise capture the outer `recipes.id` reference (same trap as
      // `plant-points.ts`).
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
          averageRating: sql<string | null>`(
            select avg(recipe_ratings.rating)
            from ${recipeRatings}
            where recipe_ratings.recipe_id = recipes.id
          )`,
          ratingCount: sql<number>`(
            select count(*)::int
            from ${recipeRatings}
            where recipe_ratings.recipe_id = recipes.id
          )`,
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
          averageRating:
            row.averageRating === null ? null : Number(row.averageRating),
          ratingCount: row.ratingCount,
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
      // Soft-deleted recipes are returned (DEC-21). The base + pair partners
      // are joined via aliased self-joins so the editor can render the
      // pair/base affordance + a "(deleted)" hint without a second request.
      const baseRecipe = alias(recipes, 'base_recipe');
      const pairedRecipe = alias(recipes, 'paired_recipe');
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
              baseRecipeName: baseRecipe.name,
              baseRecipeIsDeleted: baseRecipe.isDeleted,
              pairedRecipeName: pairedRecipe.name,
              pairedRecipeIsDeleted: pairedRecipe.isDeleted,
              isDeleted: recipes.isDeleted,
              plantPointsCount: recipePlantPointsExpr(sql`recipes.id`),
            })
            .from(recipes)
            .leftJoin(recipeSources, eq(recipes.sourceId, recipeSources.id))
            .leftJoin(baseRecipe, eq(recipes.baseRecipeId, baseRecipe.id))
            .leftJoin(pairedRecipe, eq(recipes.pairedRecipeId, pairedRecipe.id))
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
        baseRecipeName: header.baseRecipeName,
        baseRecipeIsDeleted: header.baseRecipeIsDeleted,
        pairedRecipeName: header.pairedRecipeName,
        pairedRecipeIsDeleted: header.pairedRecipeIsDeleted,
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
      if (input.sourceId !== null && input.sourceId !== undefined) {
        await assertSourceInHousehold(ctx.db, input.sourceId);
      }
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

      if (patch.sourceId !== null && patch.sourceId !== undefined) {
        await assertSourceInHousehold(ctx.db, patch.sourceId);
      }

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

  // Owns the batch-cooking write surface (DEC-23): the XOR between `isBase`
  // and `baseRecipeId`, and the application-side `pairedRecipeId` symmetry
  // transaction (DEC-26). `updateHeader` deliberately refuses these fields.
  setBatchFields: protectedProcedure
    .input(setRecipeBatchFieldsInputSchema)
    .output(setRecipeBatchFieldsResultSchema)
    .mutation(async ({ ctx, input }): Promise<SetRecipeBatchFieldsResult> => {
      const { id, isBase, baseRecipeId, pairedRecipeId } = input;

      const selfRows = await ctx.db
        .select({
          id: recipes.id,
          isBase: recipes.isBase,
          baseRecipeId: recipes.baseRecipeId,
          pairedRecipeId: recipes.pairedRecipeId,
        })
        .from(recipes)
        .where(
          and(
            eq(recipes.id, id),
            eq(recipes.householdId, CURRENT_HOUSEHOLD_ID),
          ),
        )
        .limit(1);
      const self = selfRows[0];
      if (!self) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Recipe not found',
        });
      }

      const nextIsBase = isBase ?? self.isBase;
      const nextBaseRecipeId =
        baseRecipeId === undefined ? self.baseRecipeId : baseRecipeId;
      const nextPairedRecipeId =
        pairedRecipeId === undefined ? self.pairedRecipeId : pairedRecipeId;

      // Procedure-level XOR pre-check — the DB CHECK is the backstop, but we
      // want a typed domain error before Postgres raises a generic violation
      // so the editor surfaces a clean message.
      if (nextIsBase && nextBaseRecipeId !== null) {
        throw domainBadRequest(
          'RECIPE_BATCH_XOR_VIOLATION',
          'A recipe cannot be a base and point to another base',
        );
      }

      if (nextPairedRecipeId !== null && nextPairedRecipeId === id) {
        throw domainBadRequest(
          'RECIPE_BATCH_PAIR_SELF',
          'A recipe cannot be paired with itself',
        );
      }

      if (
        baseRecipeId !== undefined &&
        baseRecipeId !== null &&
        baseRecipeId !== self.baseRecipeId
      ) {
        await assertBaseRecipePickable(ctx.db, baseRecipeId);
      }

      if (
        pairedRecipeId !== undefined &&
        pairedRecipeId !== null &&
        pairedRecipeId !== self.pairedRecipeId
      ) {
        await assertPairRecipeInHousehold(ctx.db, pairedRecipeId);
      }

      const withTransaction = makeWithTransaction(ctx.db);
      await withTransaction(async (tx) => {
        // Pair symmetry: when self.pairedRecipeId changes from A→B to A→C
        // (or to null), B (and C's old partner, if any) must have their
        // back-pointers cleared. LWW per row is acceptable per the project's
        // concurrency model (DEC-36) — no FOR UPDATE.
        if (
          pairedRecipeId !== undefined &&
          pairedRecipeId !== self.pairedRecipeId
        ) {
          let oldPartnerOfNew: number | null = null;
          if (pairedRecipeId !== null) {
            const partnerRows = await tx
              .select({ pairedRecipeId: recipes.pairedRecipeId })
              .from(recipes)
              .where(
                and(
                  eq(recipes.id, pairedRecipeId),
                  eq(recipes.householdId, CURRENT_HOUSEHOLD_ID),
                ),
              )
              .limit(1);
            oldPartnerOfNew = partnerRows[0]?.pairedRecipeId ?? null;
          }

          // Clear any row currently pointing back at self that is *not* the
          // recipe we are about to pair with. Catches both the old partner
          // and any orphaned back-pointer.
          const idsToClear: number[] = [];
          if (self.pairedRecipeId !== null && self.pairedRecipeId !== id) {
            idsToClear.push(self.pairedRecipeId);
          }
          if (
            oldPartnerOfNew !== null &&
            oldPartnerOfNew !== id &&
            !idsToClear.includes(oldPartnerOfNew)
          ) {
            idsToClear.push(oldPartnerOfNew);
          }
          if (pairedRecipeId !== null) {
            const newIndex = idsToClear.indexOf(pairedRecipeId);
            if (newIndex >= 0) idsToClear.splice(newIndex, 1);
          }

          if (idsToClear.length > 0) {
            await tx
              .update(recipes)
              .set({ pairedRecipeId: null })
              .where(
                and(
                  inArray(recipes.id, idsToClear),
                  eq(recipes.householdId, CURRENT_HOUSEHOLD_ID),
                ),
              );
          }

          if (pairedRecipeId !== null) {
            await tx
              .update(recipes)
              .set({ pairedRecipeId: id })
              .where(
                and(
                  eq(recipes.id, pairedRecipeId),
                  eq(recipes.householdId, CURRENT_HOUSEHOLD_ID),
                ),
              );
          }
        }

        const patch: Partial<typeof recipes.$inferInsert> = {};
        if (isBase !== undefined) patch.isBase = isBase;
        if (baseRecipeId !== undefined) patch.baseRecipeId = baseRecipeId;
        if (pairedRecipeId !== undefined) {
          patch.pairedRecipeId = pairedRecipeId;
        }
        if (Object.keys(patch).length > 0) {
          await tx
            .update(recipes)
            .set(patch)
            .where(
              and(
                eq(recipes.id, id),
                eq(recipes.householdId, CURRENT_HOUSEHOLD_ID),
              ),
            );
        }
      });

      return {
        id,
        isBase: nextIsBase,
        baseRecipeId: nextBaseRecipeId,
        pairedRecipeId: nextPairedRecipeId,
      };
    }),

  // Upsert keyed on `(recipe_id, user_id)` per the table's unique index. The
  // household gate is the recipe-side check (DEC-17); `recipe_ratings` itself
  // doesn't carry `household_id`. `lastUpdatedAt` is set explicitly on the
  // conflict path because Drizzle's `$onUpdate` only fires on
  // `.update(...)`, not on `onConflictDoUpdate`.
  rate: protectedProcedure
    .input(rateRecipeInputSchema)
    .output(rateRecipeResultSchema)
    .mutation(async ({ ctx, input }): Promise<RateRecipeResult> => {
      await assertRecipeInHousehold(ctx.db, input.recipeId);

      await ctx.db
        .insert(recipeRatings)
        .values({
          recipeId: input.recipeId,
          userId: ctx.user.id,
          rating: input.rating,
        })
        .onConflictDoUpdate({
          target: [recipeRatings.recipeId, recipeRatings.userId],
          set: {
            rating: input.rating,
            lastUpdatedAt: sql`now()`,
          },
        });

      return { recipeId: input.recipeId, rating: input.rating };
    }),

  // Idempotent: a missing row is a no-op, not an error — clicking the
  // currently-selected star to clear should succeed even if a parallel
  // tab already cleared it (DEC-36: last-write-wins).
  unrate: protectedProcedure
    .input(unrateRecipeInputSchema)
    .output(unrateRecipeResultSchema)
    .mutation(async ({ ctx, input }): Promise<UnrateRecipeResult> => {
      await assertRecipeInHousehold(ctx.db, input.recipeId);

      await ctx.db
        .delete(recipeRatings)
        .where(
          and(
            eq(recipeRatings.recipeId, input.recipeId),
            eq(recipeRatings.userId, ctx.user.id),
          ),
        );

      return { recipeId: input.recipeId };
    }),

  addComment: protectedProcedure
    .input(addRecipeCommentInputSchema)
    .output(addRecipeCommentResultSchema)
    .mutation(async ({ ctx, input }): Promise<AddRecipeCommentResult> => {
      await assertRecipeInHousehold(ctx.db, input.recipeId);

      const inserted = await ctx.db
        .insert(recipeComments)
        .values({
          recipeId: input.recipeId,
          userId: ctx.user.id,
          comment: input.comment,
        })
        .returning({
          id: recipeComments.id,
          recipeId: recipeComments.recipeId,
          userId: recipeComments.userId,
          comment: recipeComments.comment,
          createdAt: recipeComments.createdAt,
          lastUpdatedAt: recipeComments.lastUpdatedAt,
        });
      const row = inserted[0];
      if (!row) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Insert returned no row',
        });
      }
      return {
        id: row.id,
        recipeId: row.recipeId,
        userId: row.userId,
        authorName: ctx.user.name,
        comment: row.comment,
        createdAt: row.createdAt.toISOString(),
        lastUpdatedAt: row.lastUpdatedAt?.toISOString() ?? null,
      };
    }),

  // `lastUpdatedAt` is set explicitly to `now()` rather than via Drizzle's
  // `$onUpdate` — the column is deliberately nullable so the UI can infer
  // "never edited" (FEAT-25, schema comment on `recipe_comments`). Adding
  // `$onUpdate` would fire on INSERT too and defeat that inference.
  editComment: protectedProcedure
    .input(editRecipeCommentInputSchema)
    .output(editRecipeCommentResultSchema)
    .mutation(async ({ ctx, input }): Promise<EditRecipeCommentResult> => {
      const existing = await loadCommentForAuthor(ctx.db, input.id);
      assertCommentAuthor(existing, ctx.user.id);

      const updated = await ctx.db
        .update(recipeComments)
        .set({ comment: input.comment, lastUpdatedAt: sql`now()` })
        .where(eq(recipeComments.id, input.id))
        .returning({
          id: recipeComments.id,
          recipeId: recipeComments.recipeId,
          userId: recipeComments.userId,
          comment: recipeComments.comment,
          createdAt: recipeComments.createdAt,
          lastUpdatedAt: recipeComments.lastUpdatedAt,
        });
      const row = updated[0];
      if (!row) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Comment not found',
        });
      }
      return {
        id: row.id,
        recipeId: row.recipeId,
        userId: row.userId,
        authorName: ctx.user.name,
        comment: row.comment,
        createdAt: row.createdAt.toISOString(),
        lastUpdatedAt: row.lastUpdatedAt?.toISOString() ?? null,
      };
    }),

  deleteComment: protectedProcedure
    .input(deleteRecipeCommentInputSchema)
    .output(deleteRecipeCommentResultSchema)
    .mutation(async ({ ctx, input }): Promise<DeleteRecipeCommentResult> => {
      const existing = await loadCommentForAuthor(ctx.db, input.id);
      assertCommentAuthor(existing, ctx.user.id);

      await ctx.db
        .delete(recipeComments)
        .where(eq(recipeComments.id, input.id));

      return { id: input.id };
    }),

  listComments: protectedProcedure
    .input(listRecipeCommentsInputSchema)
    .output(listRecipeCommentsResultSchema)
    .query(async ({ ctx, input }): Promise<ListRecipeCommentsResult> => {
      await assertRecipeInHousehold(ctx.db, input.recipeId);

      const rows = await ctx.db
        .select({
          id: recipeComments.id,
          recipeId: recipeComments.recipeId,
          userId: recipeComments.userId,
          authorName: users.name,
          comment: recipeComments.comment,
          createdAt: recipeComments.createdAt,
          lastUpdatedAt: recipeComments.lastUpdatedAt,
        })
        .from(recipeComments)
        .leftJoin(users, eq(users.id, recipeComments.userId))
        .where(eq(recipeComments.recipeId, input.recipeId))
        .orderBy(desc(recipeComments.createdAt), desc(recipeComments.id));

      return {
        items: rows.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
          lastUpdatedAt: row.lastUpdatedAt?.toISOString() ?? null,
        })),
      };
    }),

  // Manually-linked symmetric pairs (DEC-27). The DB enforces uniqueness and
  // the no-self-link CHECK via composite PK + `recipe_one_id < recipe_two_id`;
  // the procedure normalises ordering and translates conflicts into typed
  // domain errors. Both sides must be pickable (in-household + not
  // soft-deleted) at link time — historical reads on soft-deleted pairs keep
  // the row, but the picker hides them.
  addRelated: protectedProcedure
    .input(addRelatedRecipeInputSchema)
    .output(addRelatedRecipeResultSchema)
    .mutation(async ({ ctx, input }): Promise<AddRelatedRecipeResult> => {
      const { recipeId, otherRecipeId } = input;
      if (recipeId === otherRecipeId) {
        throw domainBadRequest(
          'RELATED_RECIPE_SELF_LINK',
          'A recipe cannot be related to itself',
        );
      }
      await assertBothRelatedPickable(ctx.db, recipeId, otherRecipeId);

      const [recipeOneId, recipeTwoId] =
        recipeId < otherRecipeId
          ? [recipeId, otherRecipeId]
          : [otherRecipeId, recipeId];

      const inserted = await ctx.db
        .insert(relatedRecipes)
        .values({ recipeOneId, recipeTwoId })
        .onConflictDoNothing()
        .returning({ recipeOneId: relatedRecipes.recipeOneId });

      if (inserted.length === 0) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'These recipes are already linked',
          cause: { code: 'RELATED_RECIPE_DUPLICATE' satisfies DomainErrorCode },
        });
      }

      return { recipeId, otherRecipeId };
    }),

  removeRelated: protectedProcedure
    .input(removeRelatedRecipeInputSchema)
    .output(removeRelatedRecipeResultSchema)
    .mutation(async ({ ctx, input }): Promise<RemoveRelatedRecipeResult> => {
      const { recipeId, otherRecipeId } = input;
      if (recipeId === otherRecipeId) {
        throw domainBadRequest(
          'RELATED_RECIPE_SELF_LINK',
          'A recipe cannot be related to itself',
        );
      }
      // The anchor must be pickable (in-household + not soft-deleted). The
      // other side could be anything (the user might be tidying up after a
      // restore + re-delete) — the delete is a no-op if no row matches.
      await assertRecipePickable(ctx.db, recipeId);

      const [recipeOneId, recipeTwoId] =
        recipeId < otherRecipeId
          ? [recipeId, otherRecipeId]
          : [otherRecipeId, recipeId];

      await ctx.db
        .delete(relatedRecipes)
        .where(
          and(
            eq(relatedRecipes.recipeOneId, recipeOneId),
            eq(relatedRecipes.recipeTwoId, recipeTwoId),
          ),
        );

      return { recipeId, otherRecipeId };
    }),

  listRelated: protectedProcedure
    .input(listRelatedRecipesInputSchema)
    .output(listRelatedRecipesResultSchema)
    .query(async ({ ctx, input }): Promise<ListRelatedRecipesResult> => {
      // Anchor must be in-household — soft-deleted anchors are still readable
      // (historical render). `assertRecipeInHousehold` (not `Pickable`) so a
      // soft-deleted recipe's detail page can still show its related list.
      await assertRecipeInHousehold(ctx.db, input.recipeId);

      // CASE picks "the other side" of each pair. The join target is the
      // recipes row for the other id, filtered to the current household and
      // not soft-deleted per the acceptance criteria.
      const otherIdExpr = sql<number>`CASE
        WHEN ${relatedRecipes.recipeOneId} = ${input.recipeId}
          THEN ${relatedRecipes.recipeTwoId}
        ELSE ${relatedRecipes.recipeOneId}
      END`;

      const rows = await ctx.db
        .select({
          id: recipes.id,
          name: recipes.name,
          imageUrl: recipes.imageUrl,
        })
        .from(relatedRecipes)
        .innerJoin(recipes, eq(recipes.id, otherIdExpr))
        .where(
          and(
            or(
              eq(relatedRecipes.recipeOneId, input.recipeId),
              eq(relatedRecipes.recipeTwoId, input.recipeId),
            ),
            eq(recipes.householdId, CURRENT_HOUSEHOLD_ID),
            eq(recipes.isDeleted, false),
          ),
        )
        .orderBy(asc(sql`lower(${recipes.name})`), asc(recipes.id));

      return { items: rows };
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

async function assertSourceInHousehold(
  db: Db,
  sourceId: number,
): Promise<void> {
  const rows = await db
    .select({ id: recipeSources.id })
    .from(recipeSources)
    .where(
      and(
        eq(recipeSources.id, sourceId),
        eq(recipeSources.householdId, CURRENT_HOUSEHOLD_ID),
      ),
    )
    .limit(1);
  if (rows.length === 0) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Source not found' });
  }
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

// Both-sides check for the related-recipes link: each id must exist in the
// current household and not be soft-deleted. One query covers both ids so a
// cross-household / soft-deleted partner is rejected without a second probe.
async function assertBothRelatedPickable(
  db: Db,
  recipeId: number,
  otherRecipeId: number,
): Promise<void> {
  const rows = await db
    .select({ id: recipes.id })
    .from(recipes)
    .where(
      and(
        inArray(recipes.id, [recipeId, otherRecipeId]),
        eq(recipes.householdId, CURRENT_HOUSEHOLD_ID),
        eq(recipes.isDeleted, false),
      ),
    );
  const found = new Set(rows.map((row) => row.id));
  if (!found.has(recipeId) || !found.has(otherRecipeId)) {
    throw domainBadRequest(
      'RELATED_RECIPE_NOT_PICKABLE',
      'Recipe is not available to link',
    );
  }
}

async function assertRecipePickable(db: Db, recipeId: number): Promise<void> {
  const rows = await db
    .select({ id: recipes.id })
    .from(recipes)
    .where(
      and(
        eq(recipes.id, recipeId),
        eq(recipes.householdId, CURRENT_HOUSEHOLD_ID),
        eq(recipes.isDeleted, false),
      ),
    )
    .limit(1);
  if (rows.length === 0) {
    throw domainBadRequest(
      'RELATED_RECIPE_NOT_PICKABLE',
      'Recipe is not available to link',
    );
  }
}

async function assertBaseRecipePickable(
  db: Db,
  baseRecipeId: number,
): Promise<void> {
  const rows = await db
    .select({
      id: recipes.id,
      isBase: recipes.isBase,
      isDeleted: recipes.isDeleted,
    })
    .from(recipes)
    .where(
      and(
        eq(recipes.id, baseRecipeId),
        eq(recipes.householdId, CURRENT_HOUSEHOLD_ID),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw domainBadRequest(
      'RECIPE_BATCH_BASE_NOT_FOUND',
      'Base recipe not found',
    );
  }
  if (!row.isBase || row.isDeleted) {
    throw domainBadRequest(
      'RECIPE_BATCH_BASE_NOT_PICKABLE',
      'Base recipe is not pickable',
    );
  }
}

async function assertPairRecipeInHousehold(
  db: Db,
  pairedRecipeId: number,
): Promise<void> {
  const rows = await db
    .select({ id: recipes.id })
    .from(recipes)
    .where(
      and(
        eq(recipes.id, pairedRecipeId),
        eq(recipes.householdId, CURRENT_HOUSEHOLD_ID),
      ),
    )
    .limit(1);
  if (rows.length === 0) {
    throw domainBadRequest(
      'RECIPE_BATCH_PAIR_NOT_FOUND',
      'Paired recipe not found',
    );
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

interface ExistingComment {
  id: number;
  recipeId: number;
  userId: string | null;
}

async function loadCommentForAuthor(
  db: Db,
  commentId: number,
): Promise<ExistingComment> {
  const rows = await db
    .select({
      id: recipeComments.id,
      recipeId: recipeComments.recipeId,
      userId: recipeComments.userId,
      householdId: recipes.householdId,
    })
    .from(recipeComments)
    .innerJoin(recipes, eq(recipes.id, recipeComments.recipeId))
    .where(eq(recipeComments.id, commentId))
    .limit(1);
  const row = rows[0];
  if (row?.householdId !== CURRENT_HOUSEHOLD_ID) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Comment not found',
    });
  }
  return { id: row.id, recipeId: row.recipeId, userId: row.userId };
}

function assertCommentAuthor(
  comment: ExistingComment,
  callerUserId: string,
): void {
  if (comment.userId !== callerUserId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You can only edit your own comments',
    });
  }
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
