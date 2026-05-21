CREATE TYPE "public"."slot_type" AS ENUM('empty', 'recipe', 'eat_out', 'takeaway', 'leftovers');--> statement-breakpoint
CREATE TABLE "meal_plan_slots" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "meal_plan_slots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"plan_id" integer NOT NULL,
	"date" date NOT NULL,
	"occasion_id" smallint NOT NULL,
	"slot_type" "slot_type" NOT NULL,
	"recipe_id" integer,
	"number_of_servings" smallint,
	"chef_user_id" text,
	"cooks_base_recipe_id" integer,
	"cooks_base_servings" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meal_plan_slots_recipe_iff_type" CHECK (("meal_plan_slots"."slot_type" = 'recipe') = ("meal_plan_slots"."recipe_id" IS NOT NULL)),
	CONSTRAINT "meal_plan_slots_servings_when_recipe" CHECK ("meal_plan_slots"."slot_type" <> 'recipe' OR ("meal_plan_slots"."number_of_servings" IS NOT NULL AND "meal_plan_slots"."number_of_servings" > 0)),
	CONSTRAINT "meal_plan_slots_cooks_base_joint" CHECK (("meal_plan_slots"."cooks_base_recipe_id" IS NULL) = ("meal_plan_slots"."cooks_base_servings" IS NULL) AND ("meal_plan_slots"."cooks_base_servings" IS NULL OR "meal_plan_slots"."cooks_base_servings" > 0))
);
--> statement-breakpoint
CREATE TABLE "meal_plans" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "meal_plans_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"household_id" uuid NOT NULL,
	"created_by_user_id" text,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meal_plans_start_before_end" CHECK ("meal_plans"."start_date" <= "meal_plans"."end_date")
);
--> statement-breakpoint
CREATE TABLE "shopping_list_items" (
	"plan_id" integer NOT NULL,
	"ingredient_id" integer NOT NULL,
	"is_checked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shopping_list_items_plan_id_ingredient_id_pk" PRIMARY KEY("plan_id","ingredient_id")
);
--> statement-breakpoint
ALTER TABLE "meal_plan_slots" ADD CONSTRAINT "meal_plan_slots_plan_id_meal_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."meal_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_plan_slots" ADD CONSTRAINT "meal_plan_slots_occasion_id_meal_occasions_id_fk" FOREIGN KEY ("occasion_id") REFERENCES "public"."meal_occasions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_plan_slots" ADD CONSTRAINT "meal_plan_slots_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_plan_slots" ADD CONSTRAINT "meal_plan_slots_chef_user_id_users_id_fk" FOREIGN KEY ("chef_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_plan_slots" ADD CONSTRAINT "meal_plan_slots_cooks_base_recipe_id_recipes_id_fk" FOREIGN KEY ("cooks_base_recipe_id") REFERENCES "public"."recipes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_plans" ADD CONSTRAINT "meal_plans_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_plans" ADD CONSTRAINT "meal_plans_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_list_items" ADD CONSTRAINT "shopping_list_items_plan_id_meal_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."meal_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_list_items" ADD CONSTRAINT "shopping_list_items_ingredient_id_ingredients_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meal_plan_slots_plan_date_occasion_unique" ON "meal_plan_slots" USING btree ("plan_id","date","occasion_id");--> statement-breakpoint
CREATE INDEX "meal_plans_household_start_date_idx" ON "meal_plans" USING btree ("household_id","start_date");