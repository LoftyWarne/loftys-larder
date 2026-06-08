import { TRPCError } from '@trpc/server';
import { and, asc, eq, sql } from 'drizzle-orm';

import {
  createIngredientInputSchema,
  deleteIngredientInputSchema,
  ingredientListItemSchema,
  ingredientReferencesSchema,
  listIngredientsInputSchema,
  updateIngredientInputSchema,
  type DomainErrorCode,
  type IngredientListItem,
  type IngredientReferences,
} from '../../../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../../config.ts';
import { ingredients } from '../../db/schema/ingredients.ts';
import {
  ingredientCategories,
  unitsOfMeasurement,
} from '../../db/schema/reference.ts';
import { recipeIngredients } from '../../db/schema/recipes.ts';
import { protectedProcedure, router } from '../init.ts';
import { z } from 'zod';

const listResultSchema = z.array(ingredientListItemSchema);

// PG SQLSTATE 23505 = unique_violation. `pg` exposes the constraint name on
// `error.constraint`. Drizzle wraps driver errors in `DrizzleQueryError` and
// the original pg error sits on `.cause`, so walk the cause chain rather than
// inspect just the top error.
function isUniqueViolation(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current !== 'object') return false;
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (candidate.code === '23505' && candidate.constraint === constraint) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

function domainConflict(
  code: DomainErrorCode,
  message: string,
  metadata: Record<string, unknown> = {},
): TRPCError {
  return new TRPCError({
    code: 'CONFLICT',
    message,
    cause: { code, ...metadata },
  });
}

export const ingredientsRouter = router({
  references: protectedProcedure
    .output(ingredientReferencesSchema)
    .query(async ({ ctx }): Promise<IngredientReferences> => {
      const [categories, units] = await Promise.all([
        ctx.db
          .select({
            id: ingredientCategories.id,
            name: ingredientCategories.name,
          })
          .from(ingredientCategories)
          .orderBy(asc(ingredientCategories.name)),
        ctx.db
          .select({
            id: unitsOfMeasurement.id,
            name: unitsOfMeasurement.name,
          })
          .from(unitsOfMeasurement)
          .orderBy(asc(unitsOfMeasurement.name)),
      ]);
      return { categories, units };
    }),

  list: protectedProcedure
    .input(listIngredientsInputSchema)
    .output(listResultSchema)
    .query(async ({ ctx, input }): Promise<IngredientListItem[]> => {
      const conditions = [eq(ingredients.householdId, CURRENT_HOUSEHOLD_ID)];

      const search = input?.search?.trim();
      if (search) {
        const lowered = search.toLowerCase();
        conditions.push(sql`lower(${ingredients.name}) like ${`%${lowered}%`}`);
      }

      const rows = await ctx.db
        .select({
          id: ingredients.id,
          name: ingredients.name,
          categoryId: ingredients.categoryId,
          categoryName: ingredientCategories.name,
          defaultUnitId: ingredients.defaultUnitId,
          defaultUnitName: unitsOfMeasurement.name,
          isPlant: ingredients.isPlant,
          averageShelfLifeDays: ingredients.averageShelfLifeDays,
        })
        .from(ingredients)
        .innerJoin(
          ingredientCategories,
          eq(ingredients.categoryId, ingredientCategories.id),
        )
        .innerJoin(
          unitsOfMeasurement,
          eq(ingredients.defaultUnitId, unitsOfMeasurement.id),
        )
        .where(and(...conditions))
        .orderBy(asc(sql`lower(${ingredients.name})`), asc(ingredients.id));

      return rows;
    }),

  create: protectedProcedure
    .input(createIngredientInputSchema)
    .output(ingredientListItemSchema)
    .mutation(async ({ ctx, input }): Promise<IngredientListItem> => {
      let insertedId: number;
      try {
        const inserted = await ctx.db
          .insert(ingredients)
          .values({
            householdId: CURRENT_HOUSEHOLD_ID,
            name: input.name,
            categoryId: input.categoryId,
            defaultUnitId: input.defaultUnitId,
            isPlant: input.isPlant,
            averageShelfLifeDays: input.averageShelfLifeDays,
          })
          .returning({ id: ingredients.id });

        const row = inserted[0];
        if (!row) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Insert returned no row',
          });
        }
        insertedId = row.id;
      } catch (error) {
        if (
          isUniqueViolation(error, 'ingredients_household_lower_name_unique')
        ) {
          throw domainConflict(
            'INGREDIENT_NAME_TAKEN',
            'An ingredient with this name already exists',
          );
        }
        throw error;
      }

      return loadIngredient(ctx.db, insertedId);
    }),

  update: protectedProcedure
    .input(updateIngredientInputSchema)
    .output(ingredientListItemSchema)
    .mutation(async ({ ctx, input }): Promise<IngredientListItem> => {
      const { id, patch } = input;

      const patchValues: Partial<typeof ingredients.$inferInsert> = {};
      if (patch.name !== undefined) patchValues.name = patch.name;
      if (patch.categoryId !== undefined)
        patchValues.categoryId = patch.categoryId;
      if (patch.defaultUnitId !== undefined)
        patchValues.defaultUnitId = patch.defaultUnitId;
      if (patch.isPlant !== undefined) patchValues.isPlant = patch.isPlant;
      if (patch.averageShelfLifeDays !== undefined)
        patchValues.averageShelfLifeDays = patch.averageShelfLifeDays;

      let updatedId: number | undefined;
      try {
        const updated = await ctx.db
          .update(ingredients)
          .set(patchValues)
          .where(
            and(
              eq(ingredients.id, id),
              eq(ingredients.householdId, CURRENT_HOUSEHOLD_ID),
            ),
          )
          .returning({ id: ingredients.id });
        updatedId = updated[0]?.id;
      } catch (error) {
        if (
          isUniqueViolation(error, 'ingredients_household_lower_name_unique')
        ) {
          throw domainConflict(
            'INGREDIENT_NAME_TAKEN',
            'An ingredient with this name already exists',
          );
        }
        throw error;
      }

      if (updatedId === undefined) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Ingredient not found',
        });
      }

      return loadIngredient(ctx.db, updatedId);
    }),

  delete: protectedProcedure
    .input(deleteIngredientInputSchema)
    .output(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      // Soft-deleted recipes still count — past plans reference them (DEC-21).
      // No `is_deleted` filter on `recipes` here.
      const inUse = await ctx.db
        .select({ recipeId: recipeIngredients.recipeId })
        .from(recipeIngredients)
        .where(eq(recipeIngredients.ingredientId, input.id))
        .limit(1);

      if (inUse.length > 0) {
        throw domainConflict(
          'INGREDIENT_IN_USE',
          'Ingredient is referenced by one or more recipes',
        );
      }

      const deleted = await ctx.db
        .delete(ingredients)
        .where(
          and(
            eq(ingredients.id, input.id),
            eq(ingredients.householdId, CURRENT_HOUSEHOLD_ID),
          ),
        )
        .returning({ id: ingredients.id });

      const row = deleted[0];
      if (!row) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Ingredient not found',
        });
      }
      return { id: row.id };
    }),
});

async function loadIngredient(
  db: import('../../db/index.ts').Db,
  id: number,
): Promise<IngredientListItem> {
  const rows = await db
    .select({
      id: ingredients.id,
      name: ingredients.name,
      categoryId: ingredients.categoryId,
      categoryName: ingredientCategories.name,
      defaultUnitId: ingredients.defaultUnitId,
      defaultUnitName: unitsOfMeasurement.name,
      isPlant: ingredients.isPlant,
      averageShelfLifeDays: ingredients.averageShelfLifeDays,
    })
    .from(ingredients)
    .innerJoin(
      ingredientCategories,
      eq(ingredients.categoryId, ingredientCategories.id),
    )
    .innerJoin(
      unitsOfMeasurement,
      eq(ingredients.defaultUnitId, unitsOfMeasurement.id),
    )
    .where(
      and(
        eq(ingredients.id, id),
        eq(ingredients.householdId, CURRENT_HOUSEHOLD_ID),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Ingredient not found',
    });
  }
  return row;
}
