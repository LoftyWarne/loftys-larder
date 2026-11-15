import { z } from 'zod';

import {
  leftoversSourceSchema,
  planSlotSchema,
  slotTypeSchema,
  type LeftoversSource,
  type SlotType,
} from './plans.ts';

const slotIdSchema = z.number().int().positive();
const recipeIdSchema = z.number().int().positive();
const quantitySchema = z.number().int().nonnegative();

export const SLOT_COMMENT_MAX_LENGTH = 2000;

const slotCommentSchema = z
  .string()
  .trim()
  .min(1, 'Comment cannot be empty')
  .max(
    SLOT_COMMENT_MAX_LENGTH,
    `Comment must be ${String(SLOT_COMMENT_MAX_LENGTH)} characters or fewer`,
  );

// One dish in the desired slot state (DEC-91). `prepared` = portions cooked,
// `eaten` = portions consumed here; a dish must do at least one (`prepared +
// eaten > 0`). The household scope of each recipe is checked in the procedure
// (it needs a DB read); the schema just shapes the input. `sortOrder` orders
// dishes within the slot. `frozen` (FEAT-79) is the Freezer count the slot
// editor sets; left out, a dish keeps its current count (a new dish, none).
// The Fridge count is set by `slots.store` only.
export const slotItemInputSchema = z
  .object({
    recipeId: recipeIdSchema,
    prepared: quantitySchema,
    eaten: quantitySchema,
    frozen: quantitySchema.optional(),
    sortOrder: z.number().int().nonnegative(),
  })
  .refine((value) => value.prepared + value.eaten > 0, {
    path: ['prepared'],
    message: 'A dish must have a prepared or eaten quantity',
  })
  .refine(
    (value) =>
      (value.frozen ?? 0) === 0 ||
      value.eaten + (value.frozen ?? 0) <= value.prepared,
    {
      path: ['frozen'],
      message: 'Eat plus Freeze cannot exceed Prepare',
    },
  );
export type SlotItemInput = z.infer<typeof slotItemInputSchema>;

// The rules a slot's content follows, wherever a slot is written: the slot
// editor's full replace and Apply's new plan (DEC-89/DEC-91). Each item
// carries `prepared` (cooked) + `eaten` (consumed here). The second refine
// encodes the slot-status coupling in terms of what's *eaten* (`eaten > 0`
// items iff the slot is `recipe`); prepared-only cook-ahead rows are allowed
// on any type.
interface SlotContentFields {
  slotType: SlotType;
  leftoversSource: LeftoversSource | null;
  items: readonly SlotItemInput[];
}

export function withSlotContentRules<T extends z.ZodType<SlotContentFields>>(
  schema: T,
): T {
  return schema
    .refine(
      (value) =>
        (value.slotType === 'leftovers') === (value.leftoversSource !== null),
      {
        path: ['leftoversSource'],
        message:
          'leftoversSource is required when slotType is leftovers, and not allowed otherwise',
      },
    )
    .refine(
      (value) => {
        const eatenCount = value.items.filter((item) => item.eaten > 0).length;
        // A `recipe` slot is the eaten meal: at least one dish is eaten here.
        if (value.slotType === 'recipe') return eatenCount >= 1;
        // `leftovers` of a planned meal: exactly the one eaten dish (pure
        // consume — the food was cooked earlier), no cooking here.
        if (value.slotType === 'leftovers') {
          const only = value.items[0];
          return value.leftoversSource === 'plan_meal'
            ? value.items.length === 1 &&
                only !== undefined &&
                only.eaten > 0 &&
                only.prepared === 0
            : value.items.length === 0;
        }
        // empty / eat_out / takeaway: nothing eaten here (prepared-only
        // cook-ahead rows are still allowed).
        return eatenCount === 0;
      },
      {
        path: ['items'],
        message:
          'eaten items are required when slotType is recipe, are exactly one pure-consume dish for leftovers of a planned meal, and not allowed otherwise',
      },
    );
}

// Full-replace semantics: the caller declares the slot's desired final state —
// status + chef + comment + the complete `items` list. The procedure deletes
// and reinserts the items.
export const updateSlotInputSchema = withSlotContentRules(
  z.object({
    slotId: slotIdSchema,
    slotType: slotTypeSchema,
    // Required (and only allowed) when slotType is `leftovers`. `plan_meal`
    // pairs with exactly one `eat` item (the dish being eaten as leftovers);
    // `takeaway` / `other` carry no items.
    leftoversSource: leftoversSourceSchema.nullable(),
    chefUserId: z.string().min(1).nullable(),
    comment: slotCommentSchema.nullable(),
    items: z.array(slotItemInputSchema),
    // Who's eating: named household members + a guest count for accountless
    // diners. Attendance is orthogonal to the meal: it persists on every slot
    // type, including `empty` (you can know who's eating before deciding what).
    // Full-replace, like `items`: the caller always declares the complete set.
    // The procedure checks each user id exists in the household.
    dinerUserIds: z.array(z.string().min(1)),
    guestCount: z.number().int().nonnegative(),
  }),
);
export type UpdateSlotInput = z.infer<typeof updateSlotInputSchema>;

// Where a dish's portions go from the plan (FEAT-79): the Freezer or the
// Fridge. The Pantry isn't offered for cooked food.
export const PLAN_STORE_LOCATIONS = ['freezer', 'fridge'] as const;
export const planStoreLocationSchema = z.enum(PLAN_STORE_LOCATIONS);
export type PlanStoreLocation = z.infer<typeof planStoreLocationSchema>;

// A count that stopped short of what was asked. Lowering: only linked portions
// still held and not reserved can be taken back, so `applied` is above
// `requested`. Raising: portions that couldn't be taken back from the other
// location still count, so `applied` is below `requested`.
export const storedLimitSchema = z.object({
  slotItemId: z.number().int().positive(),
  location: planStoreLocationSchema,
  requested: quantitySchema,
  applied: quantitySchema,
});
export type StoredLimit = z.infer<typeof storedLimitSchema>;

export const updateSlotResultSchema = z.object({
  slot: planSlotSchema,
  storedLimits: z.array(storedLimitSchema),
});
export type UpdateSlotResult = z.infer<typeof updateSlotResultSchema>;

// FEAT-40 desktop / large-tablet drag affordance: source content moves to
// dest. When dest is populated the procedure swaps; when dest is empty the
// source is emptied. Both writes happen inside one `withTransaction` so the
// shared resource sees an atomic state — last-write-wins still applies per
// DEC-36 if two clients race.
export const relocateSlotInputSchema = z
  .object({
    sourceSlotId: slotIdSchema,
    destSlotId: slotIdSchema,
  })
  .refine((value) => value.sourceSlotId !== value.destSlotId, {
    path: ['destSlotId'],
    message: 'sourceSlotId and destSlotId must differ',
  });
export type RelocateSlotInput = z.infer<typeof relocateSlotInputSchema>;

export const relocateSlotResultSchema = z.object({
  sourceSlot: planSlotSchema,
  destSlot: planSlotSchema,
});
export type RelocateSlotResult = z.infer<typeof relocateSlotResultSchema>;

// "Store…" on a slot card (FEAT-79): the dish's new Freezer and Fridge counts.
// Raising one makes a Stock item; lowering one takes back linked portions
// still held and unreserved, as far as it can.
export const storeSlotItemInputSchema = z.object({
  slotItemId: z.number().int().positive(),
  frozen: quantitySchema,
  chilled: quantitySchema,
});
export type StoreSlotItemInput = z.infer<typeof storeSlotItemInputSchema>;

export const storeSlotItemResultSchema = z.object({
  slot: planSlotSchema,
  storedLimits: z.array(storedLimitSchema),
});
export type StoreSlotItemResult = z.infer<typeof storeSlotItemResultSchema>;
