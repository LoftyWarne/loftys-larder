CREATE TYPE "public"."slot_item_kind" AS ENUM('eat', 'cook_ahead');--> statement-breakpoint
CREATE TABLE "meal_plan_slot_items" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "meal_plan_slot_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"slot_id" integer NOT NULL,
	"recipe_id" integer NOT NULL,
	"servings" smallint NOT NULL,
	"kind" "slot_item_kind" NOT NULL,
	"sort_order" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meal_plan_slot_items_servings_positive" CHECK ("meal_plan_slot_items"."servings" > 0)
);
--> statement-breakpoint
ALTER TABLE "meal_plan_slots" DROP CONSTRAINT "meal_plan_slots_recipe_iff_type";--> statement-breakpoint
ALTER TABLE "meal_plan_slots" DROP CONSTRAINT "meal_plan_slots_servings_when_recipe";--> statement-breakpoint
ALTER TABLE "meal_plan_slots" DROP CONSTRAINT "meal_plan_slots_cooks_base_joint";--> statement-breakpoint
ALTER TABLE "meal_plan_slots" DROP CONSTRAINT "meal_plan_slots_recipe_id_recipes_id_fk";
--> statement-breakpoint
ALTER TABLE "meal_plan_slots" DROP CONSTRAINT "meal_plan_slots_cooks_base_recipe_id_recipes_id_fk";
--> statement-breakpoint
ALTER TABLE "meal_plan_slot_items" ADD CONSTRAINT "meal_plan_slot_items_slot_id_meal_plan_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."meal_plan_slots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_plan_slot_items" ADD CONSTRAINT "meal_plan_slot_items_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meal_plan_slot_items_slot_id_idx" ON "meal_plan_slot_items" USING btree ("slot_id");--> statement-breakpoint
--> data migration: fold the old per-slot recipe + base-cook fields into items
--> before the columns are dropped. Eaten recipe → an `eat` item (sort 0);
--> base cook → a `cook_ahead` item (sort 1).
INSERT INTO "meal_plan_slot_items" ("slot_id", "recipe_id", "servings", "kind", "sort_order")
  SELECT "id", "recipe_id", "number_of_servings", 'eat', 0
  FROM "meal_plan_slots"
  WHERE "recipe_id" IS NOT NULL AND "number_of_servings" IS NOT NULL;--> statement-breakpoint
INSERT INTO "meal_plan_slot_items" ("slot_id", "recipe_id", "servings", "kind", "sort_order")
  SELECT "id", "cooks_base_recipe_id", "cooks_base_servings", 'cook_ahead', 1
  FROM "meal_plan_slots"
  WHERE "cooks_base_recipe_id" IS NOT NULL AND "cooks_base_servings" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "meal_plan_slots" DROP COLUMN "recipe_id";--> statement-breakpoint
ALTER TABLE "meal_plan_slots" DROP COLUMN "number_of_servings";--> statement-breakpoint
ALTER TABLE "meal_plan_slots" DROP COLUMN "cooks_base_recipe_id";--> statement-breakpoint
ALTER TABLE "meal_plan_slots" DROP COLUMN "cooks_base_servings";