CREATE TYPE "public"."storage_location" AS ENUM('freezer', 'fridge', 'pantry');--> statement-breakpoint
CREATE TABLE "stock_items" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "stock_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"household_id" uuid NOT NULL,
	"location" "storage_location" NOT NULL,
	"ingredient_id" integer,
	"recipe_id" integer,
	"quantity" numeric(10, 3) NOT NULL,
	"added_on" date NOT NULL,
	"use_by" date,
	"source_slot_item_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_items_one_target" CHECK (("stock_items"."ingredient_id" is null) <> ("stock_items"."recipe_id" is null)),
	CONSTRAINT "stock_items_quantity_positive" CHECK ("stock_items"."quantity" > 0),
	CONSTRAINT "stock_items_use_by_fridge_only" CHECK ("stock_items"."use_by" is null or "stock_items"."location" = 'fridge')
);
--> statement-breakpoint
CREATE TABLE "stock_reservations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "stock_reservations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"household_id" uuid NOT NULL,
	"stock_item_id" integer NOT NULL,
	"plan_id" integer NOT NULL,
	"slot_item_id" integer,
	"ingredient_id" integer,
	"amount" numeric(10, 3) NOT NULL,
	"needed_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_reservations_one_reserver" CHECK (("stock_reservations"."slot_item_id" is null) <> ("stock_reservations"."ingredient_id" is null)),
	CONSTRAINT "stock_reservations_amount_positive" CHECK ("stock_reservations"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_ingredient_id_ingredients_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_source_slot_item_id_meal_plan_slot_items_id_fk" FOREIGN KEY ("source_slot_item_id") REFERENCES "public"."meal_plan_slot_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_stock_item_id_stock_items_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "public"."stock_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_plan_id_meal_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."meal_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_slot_item_id_meal_plan_slot_items_id_fk" FOREIGN KEY ("slot_item_id") REFERENCES "public"."meal_plan_slot_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_ingredient_id_ingredients_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_items_household_location_idx" ON "stock_items" USING btree ("household_id","location");--> statement-breakpoint
CREATE INDEX "stock_items_ingredient_id_idx" ON "stock_items" USING btree ("ingredient_id");--> statement-breakpoint
CREATE INDEX "stock_items_recipe_id_idx" ON "stock_items" USING btree ("recipe_id");--> statement-breakpoint
CREATE INDEX "stock_reservations_household_needed_on_idx" ON "stock_reservations" USING btree ("household_id","needed_on");--> statement-breakpoint
CREATE INDEX "stock_reservations_stock_item_id_idx" ON "stock_reservations" USING btree ("stock_item_id");