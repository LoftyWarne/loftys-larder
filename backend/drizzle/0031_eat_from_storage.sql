ALTER TYPE "public"."leftovers_source" ADD VALUE 'storage';--> statement-breakpoint
ALTER TABLE "meal_plan_slot_items" ADD COLUMN "from_storage" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "meal_plan_slot_items" ADD CONSTRAINT "meal_plan_slot_items_from_storage_non_negative" CHECK ("meal_plan_slot_items"."from_storage" >= 0);