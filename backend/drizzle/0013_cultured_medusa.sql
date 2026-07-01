ALTER TABLE "meal_plan_slot_items" DROP CONSTRAINT "meal_plan_slot_items_servings_positive";--> statement-breakpoint
--> data migration (DEC-91): add prepared/eaten nullable, backfill from the old
--> servings + kind, then enforce NOT NULL before dropping the source columns.
ALTER TABLE "meal_plan_slot_items" ADD COLUMN "prepared" smallint;--> statement-breakpoint
ALTER TABLE "meal_plan_slot_items" ADD COLUMN "eaten" smallint;--> statement-breakpoint
--> `eat` on a `recipe` slot: cooked == eaten.
UPDATE "meal_plan_slot_items" AS i
  SET "prepared" = i."servings", "eaten" = i."servings"
  FROM "meal_plan_slots" AS s
  WHERE s."id" = i."slot_id" AND i."kind" = 'eat' AND s."slot_type" = 'recipe';--> statement-breakpoint
--> `eat` on a `leftovers` slot (DEC-90 plan-meal): pure consume — the food was
--> cooked (and bought) earlier, so nothing is prepared here.
UPDATE "meal_plan_slot_items" AS i
  SET "prepared" = 0, "eaten" = i."servings"
  FROM "meal_plan_slots" AS s
  WHERE s."id" = i."slot_id" AND i."kind" = 'eat' AND s."slot_type" = 'leftovers';--> statement-breakpoint
--> `cook_ahead`: a batch produced here, none eaten at this occasion.
UPDATE "meal_plan_slot_items"
  SET "prepared" = "servings", "eaten" = 0
  WHERE "kind" = 'cook_ahead';--> statement-breakpoint
--> Safety net for any unexpected row the branches above missed: treat it as a
--> plain cooked-and-eaten dish so nothing is left NULL before SET NOT NULL.
UPDATE "meal_plan_slot_items"
  SET "prepared" = COALESCE("prepared", "servings"), "eaten" = COALESCE("eaten", "servings")
  WHERE "prepared" IS NULL OR "eaten" IS NULL;--> statement-breakpoint
ALTER TABLE "meal_plan_slot_items" ALTER COLUMN "prepared" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "meal_plan_slot_items" ALTER COLUMN "eaten" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "meal_plan_slot_items" DROP COLUMN "servings";--> statement-breakpoint
ALTER TABLE "meal_plan_slot_items" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "meal_plan_slot_items" ADD CONSTRAINT "meal_plan_slot_items_prepared_non_negative" CHECK ("meal_plan_slot_items"."prepared" >= 0);--> statement-breakpoint
ALTER TABLE "meal_plan_slot_items" ADD CONSTRAINT "meal_plan_slot_items_eaten_non_negative" CHECK ("meal_plan_slot_items"."eaten" >= 0);--> statement-breakpoint
ALTER TABLE "meal_plan_slot_items" ADD CONSTRAINT "meal_plan_slot_items_prepared_or_eaten" CHECK ("meal_plan_slot_items"."prepared" + "meal_plan_slot_items"."eaten" > 0);--> statement-breakpoint
DROP TYPE "public"."slot_item_kind";
