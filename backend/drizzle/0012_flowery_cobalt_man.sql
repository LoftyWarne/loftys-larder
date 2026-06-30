CREATE TYPE "public"."leftovers_source" AS ENUM('plan_meal', 'takeaway', 'other');--> statement-breakpoint
ALTER TABLE "meal_plan_slots" ADD COLUMN "leftovers_source" "leftovers_source";--> statement-breakpoint
UPDATE "meal_plan_slots" SET "leftovers_source" = 'other' WHERE "slot_type" = 'leftovers' AND "leftovers_source" IS NULL;--> statement-breakpoint
ALTER TABLE "meal_plan_slots" ADD CONSTRAINT "meal_plan_slots_leftovers_source_coupling" CHECK (("meal_plan_slots"."slot_type" = 'leftovers') = ("meal_plan_slots"."leftovers_source" is not null));