import { TRPCError } from '@trpc/server';
import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm';

import {
  createStockItemInputSchema,
  defaultUseBy,
  deleteStockItemInputSchema,
  deleteStockItemResultSchema,
  deleteStockItemsInputSchema,
  deleteStockItemsResultSchema,
  isValidPortions,
  listStorageResultSchema,
  stockItemSchema,
  updateStockItemInputSchema,
  updateStockItemResultSchema,
  type DeleteStockItemResult,
  type DeleteStockItemsResult,
  type DomainErrorCode,
  type ListStorageResult,
  type StockItem,
  type StorageLocation,
  type StorageStaple,
  type UpdateStockItemResult,
  type UseByTarget,
} from '../../../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../../config.ts';
import { ingredients } from '../../db/schema/ingredients.ts';
import { unitsOfMeasurement } from '../../db/schema/reference.ts';
import { recipes } from '../../db/schema/recipes.ts';
import { stockItems, stockReservations } from '../../db/schema/storage.ts';
import { makeWithTransaction, type Tx } from '../../db/withTransaction.ts';
import {
  formatCivilDate,
  parseCivilDate,
  todayInLondon,
} from '../../lib/date-utils.ts';
import { pickableRecipesWhere } from '../../lib/pickable-recipes.ts';
import { settleReservations } from '../../lib/stock-settlement.ts';
import { protectedProcedure, router } from '../init.ts';

function domainError(
  code: TRPCError['code'],
  domainCode: DomainErrorCode,
  message: string,
  metadata: Record<string, unknown> = {},
): TRPCError {
  return new TRPCError({
    code,
    message,
    cause: { code: domainCode, ...metadata },
  });
}

function stockItemNotFound(): TRPCError {
  return domainError(
    'NOT_FOUND',
    'STOCK_ITEM_NOT_FOUND',
    'Stock item not found',
  );
}

// Milli-units, so amounts compare and subtract exactly.
function toMilli(quantity: string): number {
  return Math.round(Number(quantity) * 1000);
}

function fromMilli(milli: number): string {
  return (milli / 1000).toFixed(3);
}

function assertNotFuture(addedOn: string, today: Date): void {
  if (parseCivilDate(addedOn) > today) {
    throw domainError(
      'BAD_REQUEST',
      'STOCK_ADDED_ON_FUTURE',
      'An item can’t be added after today',
    );
  }
}

const reservedSql = sql<string>`coalesce((
  select sum(${stockReservations.amount})
  from ${stockReservations}
  where ${stockReservations.stockItemId} = ${stockItems.id}
    and ${stockReservations.householdId} = ${CURRENT_HOUSEHOLD_ID}
), 0)::numeric(10,3)::text`;

async function listItems(tx: Tx): Promise<StockItem[]> {
  const rows = await tx
    .select({
      id: stockItems.id,
      location: stockItems.location,
      quantity: stockItems.quantity,
      reserved: reservedSql,
      addedOn: stockItems.addedOn,
      useBy: stockItems.useBy,
      ingredientId: ingredients.id,
      ingredientName: ingredients.name,
      unitName: unitsOfMeasurement.name,
      averageShelfLifeDays: ingredients.averageShelfLifeDays,
      recipeId: recipes.id,
      recipeName: recipes.name,
      isBase: recipes.isBase,
      isDeleted: recipes.isDeleted,
    })
    .from(stockItems)
    .leftJoin(
      ingredients,
      and(
        eq(stockItems.ingredientId, ingredients.id),
        eq(ingredients.householdId, CURRENT_HOUSEHOLD_ID),
      ),
    )
    .leftJoin(
      unitsOfMeasurement,
      eq(ingredients.defaultUnitId, unitsOfMeasurement.id),
    )
    .leftJoin(
      recipes,
      and(
        eq(stockItems.recipeId, recipes.id),
        eq(recipes.householdId, CURRENT_HOUSEHOLD_ID),
      ),
    )
    .where(eq(stockItems.householdId, CURRENT_HOUSEHOLD_ID))
    .orderBy(asc(stockItems.addedOn), asc(stockItems.id));

  const items: StockItem[] = [];
  for (const row of rows) {
    const base = {
      id: row.id,
      location: row.location,
      quantity: row.quantity,
      reserved: row.reserved,
      addedOn: formatCivilDate(row.addedOn),
      useBy: row.useBy ? formatCivilDate(row.useBy) : null,
    };
    if (row.ingredientId !== null && row.ingredientName !== null) {
      items.push({
        ...base,
        target: {
          kind: 'ingredient',
          ingredientId: row.ingredientId,
          name: row.ingredientName,
          unitName: row.unitName ?? '',
          averageShelfLifeDays: row.averageShelfLifeDays,
        },
      });
    } else if (row.recipeId !== null && row.recipeName !== null) {
      items.push({
        ...base,
        target: {
          kind: 'recipe',
          recipeId: row.recipeId,
          name: row.recipeName,
          isBase: row.isBase ?? false,
          isDeleted: row.isDeleted ?? false,
        },
      });
    }
  }
  return items;
}

async function listStaples(tx: Tx): Promise<StorageStaple[]> {
  const rows = await tx
    .select({
      ingredientId: ingredients.id,
      name: ingredients.name,
      location: ingredients.stapleLocation,
      state: ingredients.stapleState,
    })
    .from(ingredients)
    .where(
      and(
        eq(ingredients.householdId, CURRENT_HOUSEHOLD_ID),
        isNotNull(ingredients.stapleState),
      ),
    )
    .orderBy(asc(sql`lower(${ingredients.name})`), asc(ingredients.id));
  const staples: StorageStaple[] = [];
  for (const row of rows) {
    if (row.location !== null && row.state !== null) {
      staples.push({
        ingredientId: row.ingredientId,
        name: row.name,
        location: row.location,
        state: row.state,
      });
    }
  }
  return staples;
}

interface LoadedItem {
  id: number;
  location: StorageLocation;
  quantity: string;
  useBy: Date | null;
  useByTarget: UseByTarget;
}

async function loadItemForUpdate(tx: Tx, id: number): Promise<LoadedItem> {
  const rows = await tx
    .select({
      id: stockItems.id,
      location: stockItems.location,
      quantity: stockItems.quantity,
      useBy: stockItems.useBy,
      recipeId: stockItems.recipeId,
      averageShelfLifeDays: ingredients.averageShelfLifeDays,
    })
    .from(stockItems)
    .leftJoin(
      ingredients,
      and(
        eq(stockItems.ingredientId, ingredients.id),
        eq(ingredients.householdId, CURRENT_HOUSEHOLD_ID),
      ),
    )
    .where(
      and(
        eq(stockItems.id, id),
        eq(stockItems.householdId, CURRENT_HOUSEHOLD_ID),
      ),
    )
    .for('update', { of: stockItems });
  const row = rows[0];
  if (!row) throw stockItemNotFound();
  return {
    id: row.id,
    location: row.location,
    quantity: row.quantity,
    useBy: row.useBy,
    useByTarget:
      row.recipeId !== null
        ? { kind: 'recipe' }
        : {
            kind: 'ingredient',
            averageShelfLifeDays: row.averageShelfLifeDays,
          },
  };
}

// Releases whole Reservations, latest needed first, until what's left fits in
// `quantityMilli`. Without the cook's go-ahead it refuses instead.
async function releaseUncovered(
  tx: Tx,
  stockItemId: number,
  quantityMilli: number,
  release: boolean,
): Promise<number> {
  const reservations = await tx
    .select({ id: stockReservations.id, amount: stockReservations.amount })
    .from(stockReservations)
    .where(
      and(
        eq(stockReservations.stockItemId, stockItemId),
        eq(stockReservations.householdId, CURRENT_HOUSEHOLD_ID),
      ),
    )
    .orderBy(desc(stockReservations.neededOn), desc(stockReservations.id));

  let reservedMilli = reservations.reduce(
    (sum, reservation) => sum + toMilli(reservation.amount),
    0,
  );
  if (reservedMilli <= quantityMilli) return 0;
  if (!release) {
    throw domainError(
      'CONFLICT',
      'STOCK_RESERVED',
      'Some of this is set aside for a plan',
      {
        quantity: fromMilli(quantityMilli),
        reserved: fromMilli(reservedMilli),
      },
    );
  }

  let released = 0;
  for (const reservation of reservations) {
    if (reservedMilli <= quantityMilli) break;
    await tx
      .delete(stockReservations)
      .where(
        and(
          eq(stockReservations.id, reservation.id),
          eq(stockReservations.householdId, CURRENT_HOUSEHOLD_ID),
        ),
      );
    reservedMilli -= toMilli(reservation.amount);
    released += 1;
  }
  return released;
}

async function deleteItem(tx: Tx, id: number): Promise<void> {
  await tx
    .delete(stockItems)
    .where(
      and(
        eq(stockItems.id, id),
        eq(stockItems.householdId, CURRENT_HOUSEHOLD_ID),
      ),
    );
}

export const storageRouter = router({
  list: protectedProcedure
    .output(listStorageResultSchema)
    .query(async ({ ctx }): Promise<ListStorageResult> => {
      const today = todayInLondon();
      const withTransaction = makeWithTransaction(ctx.db);
      const { items, staples } = await withTransaction(async (tx) => {
        await settleReservations(tx, today);
        return { items: await listItems(tx), staples: await listStaples(tx) };
      });
      return { today: formatCivilDate(today), items, staples };
    }),

  create: protectedProcedure
    .input(createStockItemInputSchema)
    .output(stockItemSchema.pick({ id: true }))
    .mutation(async ({ ctx, input }) => {
      const today = todayInLondon();
      assertNotFuture(input.addedOn, today);

      const withTransaction = makeWithTransaction(ctx.db);
      return withTransaction(async (tx) => {
        let useByTarget: UseByTarget;
        if (input.target.kind === 'ingredient') {
          const rows = await tx
            .select({
              averageShelfLifeDays: ingredients.averageShelfLifeDays,
              stapleState: ingredients.stapleState,
            })
            .from(ingredients)
            .where(
              and(
                eq(ingredients.id, input.target.ingredientId),
                eq(ingredients.householdId, CURRENT_HOUSEHOLD_ID),
              ),
            )
            // Holds off the ingredient's delete or unit change until this
            // item is in, so their storage guards see it.
            .for('key share');
          const row = rows[0];
          if (!row) {
            throw domainError(
              'NOT_FOUND',
              'STOCK_TARGET_NOT_FOUND',
              'Ingredient not found',
            );
          }
          if (row.stapleState !== null) {
            throw domainError(
              'CONFLICT',
              'STOCK_INGREDIENT_IS_STAPLE',
              'A Staple is tracked by its state, not as stock',
            );
          }
          useByTarget = {
            kind: 'ingredient',
            averageShelfLifeDays: row.averageShelfLifeDays,
          };
        } else {
          const rows = await tx
            .select({ id: recipes.id })
            .from(recipes)
            .where(
              and(
                eq(recipes.id, input.target.recipeId),
                pickableRecipesWhere({ includePickerHidden: true }),
              ),
            );
          if (!rows[0]) {
            throw domainError(
              'NOT_FOUND',
              'STOCK_TARGET_NOT_FOUND',
              'Recipe not found',
            );
          }
          useByTarget = { kind: 'recipe' };
        }

        let useBy: string | null = null;
        if (input.location === 'fridge') {
          useBy =
            input.useBy === undefined
              ? defaultUseBy(input.addedOn, useByTarget)
              : input.useBy;
        }

        const inserted = await tx
          .insert(stockItems)
          .values({
            householdId: CURRENT_HOUSEHOLD_ID,
            location: input.location,
            ingredientId:
              input.target.kind === 'ingredient'
                ? input.target.ingredientId
                : null,
            recipeId:
              input.target.kind === 'recipe' ? input.target.recipeId : null,
            quantity: input.quantity,
            addedOn: parseCivilDate(input.addedOn),
            useBy: useBy === null ? null : parseCivilDate(useBy),
          })
          .returning({ id: stockItems.id });
        const row = inserted[0];
        if (!row) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Insert returned no row',
          });
        }
        return { id: row.id };
      });
    }),

  update: protectedProcedure
    .input(updateStockItemInputSchema)
    .output(updateStockItemResultSchema)
    .mutation(async ({ ctx, input }): Promise<UpdateStockItemResult> => {
      const { patch } = input;
      const today = todayInLondon();
      if (patch.addedOn !== undefined) assertNotFuture(patch.addedOn, today);

      const withTransaction = makeWithTransaction(ctx.db);
      return withTransaction(async (tx) => {
        await settleReservations(tx, today);
        const item = await loadItemForUpdate(tx, input.id);

        if (
          patch.quantity !== undefined &&
          item.useByTarget.kind === 'recipe' &&
          !isValidPortions(patch.quantity)
        ) {
          throw domainError(
            'BAD_REQUEST',
            'STOCK_PORTIONS_NOT_HALVES',
            'Portions must be whole or half',
          );
        }

        const location = patch.location ?? item.location;
        if (location !== 'fridge' && patch.useBy != null) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Only Fridge items have a Use-by',
          });
        }

        const quantityMilli =
          patch.quantity === undefined
            ? toMilli(item.quantity)
            : toMilli(patch.quantity);
        const released = await releaseUncovered(
          tx,
          item.id,
          quantityMilli,
          input.releaseReservations ?? false,
        );

        if (quantityMilli === 0) {
          await deleteItem(tx, item.id);
          return { id: item.id, deleted: true, releasedReservations: released };
        }

        let useBy: Date | null | undefined;
        if (location !== 'fridge') {
          useBy = null;
        } else if (patch.useBy !== undefined) {
          useBy = patch.useBy === null ? null : parseCivilDate(patch.useBy);
        } else if (item.location !== 'fridge') {
          const fresh = defaultUseBy(formatCivilDate(today), item.useByTarget);
          useBy = fresh === null ? null : parseCivilDate(fresh);
        }

        await tx
          .update(stockItems)
          .set({
            location,
            ...(patch.quantity !== undefined && { quantity: patch.quantity }),
            ...(patch.addedOn !== undefined && {
              addedOn: parseCivilDate(patch.addedOn),
            }),
            ...(useBy !== undefined && { useBy }),
          })
          .where(
            and(
              eq(stockItems.id, item.id),
              eq(stockItems.householdId, CURRENT_HOUSEHOLD_ID),
            ),
          );
        return { id: item.id, deleted: false, releasedReservations: released };
      });
    }),

  delete: protectedProcedure
    .input(deleteStockItemInputSchema)
    .output(deleteStockItemResultSchema)
    .mutation(async ({ ctx, input }): Promise<DeleteStockItemResult> => {
      const today = todayInLondon();
      const withTransaction = makeWithTransaction(ctx.db);
      return withTransaction(async (tx) => {
        await settleReservations(tx, today);
        const item = await loadItemForUpdate(tx, input.id);
        const released = await releaseUncovered(
          tx,
          item.id,
          0,
          input.releaseReservations ?? false,
        );
        await deleteItem(tx, item.id);
        return { id: item.id, releasedReservations: released };
      });
    }),

  deleteMany: protectedProcedure
    .input(deleteStockItemsInputSchema)
    .output(deleteStockItemsResultSchema)
    .mutation(async ({ ctx, input }): Promise<DeleteStockItemsResult> => {
      const today = todayInLondon();
      const withTransaction = makeWithTransaction(ctx.db);
      // Ascending ids lock in a stable order, so two overlapping removals
      // can't deadlock.
      const ids = [...new Set(input.ids)].sort((a, b) => a - b);
      return withTransaction(async (tx) => {
        await settleReservations(tx, today);
        let released = 0;
        for (const id of ids) {
          const item = await loadItemForUpdate(tx, id);
          released += await releaseUncovered(
            tx,
            item.id,
            0,
            input.releaseReservations ?? false,
          );
          await deleteItem(tx, item.id);
        }
        return { ids, releasedReservations: released };
      });
    }),
});
