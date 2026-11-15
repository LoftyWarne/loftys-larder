CREATE TYPE "public"."staple_state" AS ENUM('in_stock', 'running_low', 'out');--> statement-breakpoint
ALTER TABLE "ingredients" ADD COLUMN "staple_state" "staple_state";--> statement-breakpoint
ALTER TABLE "ingredients" ADD COLUMN "staple_location" "storage_location";--> statement-breakpoint
ALTER TABLE "meal_plans" ADD COLUMN "storage_glance_dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shopping_list_items" ADD COLUMN "replaced_staple_state" "staple_state";--> statement-breakpoint
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_staple_state_with_location" CHECK (("ingredients"."staple_state" is null) = ("ingredients"."staple_location" is null));