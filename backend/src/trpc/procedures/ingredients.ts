import { TRPCError } from '@trpc/server';
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import {
  createIngredientInputSchema,
  deleteIngredientInputSchema,
  ingredientListItemSchema,
  ingredientReferencesSchema,
  listIngredientsInputSchema,
  setStapleStateInputSchema,
  updateIngredientInputSchema,
  type DomainErrorCode,
  type IngredientListItem,
  type IngredientReferences,
  type StorageLocation,
} from '../../../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../../config.ts';
import { ingredients } from '../../db/schema/ingredients.ts';
import { mealPlans } from '../../db/schema/meal-plans.ts';
import {
  ingredientCategories,
  unitsOfMeasurement,
} from '../../db/schema/reference.ts';
import {
  recipeIngredients,
  recipeMethodIngredients,
} from '../../db/schema/recipes.ts';
import { shoppingListItems } from '../../db/schema/shopping-list.ts';
import { stockItems, stockReservations } from '../../db/schema/storage.ts';
import { makeWithTransaction, type Tx } from '../../db/withTransaction.ts';
import { todayInLondon } from '../../lib/date-utils.ts';
import { settleReservations } from '../../lib/stock-settlement.ts';
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
          stapleState: ingredients.stapleState,
          stapleLocation: ingredients.stapleLocation,
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
            // A new ingredient holds no stock, so it can be a Staple at once.
            ...(input.stapleLocation != null && {
              stapleLocation: input.stapleLocation,
              stapleState: 'in_stock' as const,
            }),
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
      // `stapleLocation` is applied by `applyStapleLocation`, which also sets
      // the state.

      const withTransaction = makeWithTransaction(ctx.db);
      let updatedId: number | undefined;
      try {
        updatedId = await withTransaction(async (tx) => {
          if (patch.stapleLocation !== undefined) {
            await applyStapleLocation(
              tx,
              id,
              patch.stapleLocation,
              input.deleteStock ?? false,
            );
          }

          // Held amounts are in the ingredient's one unit (DEC-18), so a new
          // unit would misread them. The cook clears the stock first. The
          // row lock holds off a Stock item being added meanwhile.
          if (patch.defaultUnitId !== undefined) {
            const [current] = await tx
              .select({ defaultUnitId: ingredients.defaultUnitId })
              .from(ingredients)
              .where(
                and(
                  eq(ingredients.id, id),
                  eq(ingredients.householdId, CURRENT_HOUSEHOLD_ID),
                ),
              )
              .for('update');
            if (current && current.defaultUnitId !== patch.defaultUnitId) {
              const held = await tx
                .select({ id: stockItems.id })
                .from(stockItems)
                .where(
                  and(
                    eq(stockItems.ingredientId, id),
                    eq(stockItems.householdId, CURRENT_HOUSEHOLD_ID),
                  ),
                )
                .limit(1);
              if (held.length > 0) {
                throw domainConflict(
                  'INGREDIENT_UNIT_IN_STOCK',
                  'The ingredient is held in storage in its current unit',
                );
              }
            }
          }

          if (Object.keys(patchValues).length === 0) {
            const [found] = await tx
              .select({ id: ingredients.id })
              .from(ingredients)
              .where(
                and(
                  eq(ingredients.id, id),
                  eq(ingredients.householdId, CURRENT_HOUSEHOLD_ID),
                ),
              );
            return found?.id;
          }

          const updated = await tx
            .update(ingredients)
            .set(patchValues)
            .where(
              and(
                eq(ingredients.id, id),
                eq(ingredients.householdId, CURRENT_HOUSEHOLD_ID),
              ),
            )
            .returning({ id: ingredients.id });
          return updated[0]?.id;
        });
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

  setStapleState: protectedProcedure
    .input(setStapleStateInputSchema)
    .output(ingredientListItemSchema)
    .mutation(async ({ ctx, input }): Promise<IngredientListItem> => {
      const updated = await ctx.db
        .update(ingredients)
        .set({ stapleState: input.state })
        .where(
          and(
            eq(ingredients.id, input.id),
            eq(ingredients.householdId, CURRENT_HOUSEHOLD_ID),
            isNotNull(ingredients.stapleLocation),
          ),
        )
        .returning({ id: ingredients.id });
      const row = updated[0];
      if (!row) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Staple not found',
          cause: { code: 'INGREDIENT_NOT_STAPLE' },
        });
      }
      return loadIngredient(ctx.db, row.id);
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

      // A step link to an ingredient that's in no recipe line is invisible
      // (DEC-99), so it shouldn't block deletion; clear it first.
      const withTransaction = makeWithTransaction(ctx.db);
      const deleted = await withTransaction(async (tx) => {
        // The row lock holds off a Stock item being added meanwhile.
        await tx
          .select({ id: ingredients.id })
          .from(ingredients)
          .where(
            and(
              eq(ingredients.id, input.id),
              eq(ingredients.householdId, CURRENT_HOUSEHOLD_ID),
            ),
          )
          .for('update');
        const held = await tx
          .select({ id: stockItems.id })
          .from(stockItems)
          .where(
            and(
              eq(stockItems.ingredientId, input.id),
              eq(stockItems.householdId, CURRENT_HOUSEHOLD_ID),
            ),
          )
          .limit(1);
        if (held.length > 0) {
          throw domainConflict(
            'INGREDIENT_IN_USE',
            'Ingredient is held in storage',
            { inStorage: true },
          );
        }

        await tx.delete(recipeMethodIngredients).where(
          inArray(
            recipeMethodIngredients.ingredientId,
            tx
              .select({ id: ingredients.id })
              .from(ingredients)
              .where(
                and(
                  eq(ingredients.id, input.id),
                  eq(ingredients.householdId, CURRENT_HOUSEHOLD_ID),
                ),
              ),
          ),
        );
        // Tick state outlives the recipe lines that put the ingredient on a
        // list (DEC-30); once no recipe uses it the line is gone, so drop it.
        await tx
          .delete(shoppingListItems)
          .where(
            and(
              eq(shoppingListItems.ingredientId, input.id),
              inArray(
                shoppingListItems.planId,
                tx
                  .select({ id: mealPlans.id })
                  .from(mealPlans)
                  .where(eq(mealPlans.householdId, CURRENT_HOUSEHOLD_ID)),
              ),
            ),
          );
        return tx
          .delete(ingredients)
          .where(
            and(
              eq(ingredients.id, input.id),
              eq(ingredients.householdId, CURRENT_HOUSEHOLD_ID),
            ),
          )
          .returning({ id: ingredients.id });
      });

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

// Marks, moves or unmarks a Staple (DEC-118). A Staple is never a Stock item,
// so marking a held ingredient deletes its Stock items, which releases their
// Reservations, once the cook has agreed. Moving keeps the state, and a new
// Staple starts in stock.
async function applyStapleLocation(
  tx: Tx,
  id: number,
  location: StorageLocation | null,
  deleteStock: boolean,
): Promise<void> {
  if (location === null) {
    await tx
      .update(ingredients)
      .set({ stapleState: null, stapleLocation: null })
      .where(
        and(
          eq(ingredients.id, id),
          eq(ingredients.householdId, CURRENT_HOUSEHOLD_ID),
        ),
      );
    return;
  }

  // Settling locks Reservations before Stock items, the order every storage
  // path takes. The ingredient's row lock then holds off a Stock item being
  // added meanwhile.
  await settleReservations(tx, todayInLondon());
  const [current] = await tx
    .select({ stapleState: ingredients.stapleState })
    .from(ingredients)
    .where(
      and(
        eq(ingredients.id, id),
        eq(ingredients.householdId, CURRENT_HOUSEHOLD_ID),
      ),
    )
    .for('update');
  if (!current) return;

  if (current.stapleState === null) {
    const [held] = await tx
      .select({
        stockItems: sql<number>`count(distinct ${stockItems.id})::int`,
        reservations: sql<number>`count(${stockReservations.id})::int`,
      })
      .from(stockItems)
      .leftJoin(
        stockReservations,
        and(
          eq(stockReservations.stockItemId, stockItems.id),
          eq(stockReservations.householdId, CURRENT_HOUSEHOLD_ID),
        ),
      )
      .where(
        and(
          eq(stockItems.ingredientId, id),
          eq(stockItems.householdId, CURRENT_HOUSEHOLD_ID),
        ),
      );
    if (held && held.stockItems > 0) {
      if (!deleteStock) {
        throw domainConflict(
          'INGREDIENT_STAPLE_HAS_STOCK',
          'The ingredient is held in storage',
          { stockItems: held.stockItems, reservations: held.reservations },
        );
      }
      await tx
        .delete(stockItems)
        .where(
          and(
            eq(stockItems.ingredientId, id),
            eq(stockItems.householdId, CURRENT_HOUSEHOLD_ID),
          ),
        );
    }
  }

  await tx
    .update(ingredients)
    .set({
      stapleLocation: location,
      stapleState: current.stapleState ?? 'in_stock',
    })
    .where(
      and(
        eq(ingredients.id, id),
        eq(ingredients.householdId, CURRENT_HOUSEHOLD_ID),
      ),
    );
}

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
      stapleState: ingredients.stapleState,
      stapleLocation: ingredients.stapleLocation,
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
