CREATE TYPE "public"."recipe_draft_kind" AS ENUM('manual', 'import');--> statement-breakpoint
ALTER TABLE "recipe_drafts" ADD COLUMN "kind" "recipe_draft_kind" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "nutrition_is_estimated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "recipe_drafts" ADD CONSTRAINT "recipe_drafts_import_has_no_recipe" CHECK ("recipe_drafts"."kind" = 'manual' OR "recipe_drafts"."recipe_id" IS NULL);