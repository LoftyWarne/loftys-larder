CREATE TYPE "public"."step_prep_ahead" AS ENUM('optional', 'required');--> statement-breakpoint
ALTER TABLE "recipe_method" ADD COLUMN "prep_ahead" "step_prep_ahead";