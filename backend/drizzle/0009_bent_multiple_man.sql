ALTER TABLE "recipes" DROP CONSTRAINT "recipes_base_xor_batch";--> statement-breakpoint
ALTER TABLE "recipes" DROP CONSTRAINT "recipes_paired_not_self";--> statement-breakpoint
ALTER TABLE "recipes" DROP CONSTRAINT "recipes_paired_recipe_id_recipes_id_fk";
--> statement-breakpoint
ALTER TABLE "recipes" DROP COLUMN "paired_recipe_id";--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_base_xor_variation" CHECK (NOT ("recipes"."is_base" AND "recipes"."base_recipe_id" IS NOT NULL));