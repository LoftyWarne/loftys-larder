-- Required for the trigram GIN indexes on `ingredients.name` and `recipes.name`
-- below. Must run before any `gin_trgm_ops` reference. Added manually because
-- drizzle-kit doesn't track extensions; the rest of this file is generated.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "ingredients" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ingredients_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category_id" smallint NOT NULL,
	"default_unit_id" smallint NOT NULL,
	"average_shelf_life_days" smallint,
	"is_plant" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipe_drafts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "recipe_drafts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"recipe_id" integer,
	"draft_data" jsonb NOT NULL,
	"last_updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipe_comments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "recipe_comments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"recipe_id" integer NOT NULL,
	"user_id" text,
	"comment" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "recipe_ratings" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "recipe_ratings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"recipe_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"rating" smallint NOT NULL,
	"last_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_ratings_rating_range" CHECK ("recipe_ratings"."rating" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "related_recipes" (
	"recipe_one_id" integer NOT NULL,
	"recipe_two_id" integer NOT NULL,
	CONSTRAINT "related_recipes_recipe_one_id_recipe_two_id_pk" PRIMARY KEY("recipe_one_id","recipe_two_id"),
	CONSTRAINT "related_recipes_one_lt_two" CHECK ("related_recipes"."recipe_one_id" < "related_recipes"."recipe_two_id")
);
--> statement-breakpoint
CREATE TABLE "recipe_ingredients" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "recipe_ingredients_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"recipe_id" integer NOT NULL,
	"ingredient_id" integer NOT NULL,
	"quantity" numeric(10, 3) NOT NULL,
	"prep_type_id" smallint
);
--> statement-breakpoint
CREATE TABLE "recipe_method" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "recipe_method_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"recipe_id" integer NOT NULL,
	"step_number" smallint NOT NULL,
	"instruction" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipe_sources" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "recipe_sources_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"household_id" uuid NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipes" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "recipes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"image_url" text,
	"base_servings" smallint NOT NULL,
	"active_time_mins" smallint,
	"total_time_mins" smallint,
	"estimated_cost_per_serving" numeric(10, 2),
	"source_id" integer,
	"source_url" text,
	"calories_per_serving" smallint,
	"protein_per_serving" smallint,
	"carbs_per_serving" smallint,
	"fat_per_serving" smallint,
	"saturated_fat_per_serving" smallint,
	"fibre_per_serving" smallint,
	"sugar_per_serving" smallint,
	"salt_per_serving" smallint,
	"added_by_user_id" text,
	"date_added" date DEFAULT current_date NOT NULL,
	"date_last_updated" date DEFAULT current_date NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"is_base" boolean DEFAULT false NOT NULL,
	"base_recipe_id" integer,
	"paired_recipe_id" integer,
	CONSTRAINT "recipes_base_not_self" CHECK ("recipes"."base_recipe_id" IS NULL OR "recipes"."base_recipe_id" != "recipes"."id"),
	CONSTRAINT "recipes_base_xor_batch" CHECK (NOT ("recipes"."is_base" AND "recipes"."base_recipe_id" IS NOT NULL)),
	CONSTRAINT "recipes_paired_not_self" CHECK ("recipes"."paired_recipe_id" IS NULL OR "recipes"."paired_recipe_id" != "recipes"."id")
);
--> statement-breakpoint
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_category_id_ingredient_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."ingredient_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_default_unit_id_units_of_measurement_id_fk" FOREIGN KEY ("default_unit_id") REFERENCES "public"."units_of_measurement"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_drafts" ADD CONSTRAINT "recipe_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_drafts" ADD CONSTRAINT "recipe_drafts_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_comments" ADD CONSTRAINT "recipe_comments_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_comments" ADD CONSTRAINT "recipe_comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ratings" ADD CONSTRAINT "recipe_ratings_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ratings" ADD CONSTRAINT "recipe_ratings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "related_recipes" ADD CONSTRAINT "related_recipes_recipe_one_id_recipes_id_fk" FOREIGN KEY ("recipe_one_id") REFERENCES "public"."recipes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "related_recipes" ADD CONSTRAINT "related_recipes_recipe_two_id_recipes_id_fk" FOREIGN KEY ("recipe_two_id") REFERENCES "public"."recipes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_ingredient_id_ingredients_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_prep_type_id_preparation_types_id_fk" FOREIGN KEY ("prep_type_id") REFERENCES "public"."preparation_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_method" ADD CONSTRAINT "recipe_method_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_sources" ADD CONSTRAINT "recipe_sources_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_source_id_recipe_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."recipe_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_base_recipe_id_recipes_id_fk" FOREIGN KEY ("base_recipe_id") REFERENCES "public"."recipes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_paired_recipe_id_recipes_id_fk" FOREIGN KEY ("paired_recipe_id") REFERENCES "public"."recipes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingredients_household_id_idx" ON "ingredients" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "ingredients_name_trgm_idx" ON "ingredients" USING gin (lower("name") gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_drafts_user_recipe_unique" ON "recipe_drafts" USING btree ("user_id","recipe_id");--> statement-breakpoint
CREATE INDEX "recipe_comments_recipe_id_idx" ON "recipe_comments" USING btree ("recipe_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_ratings_recipe_user_unique" ON "recipe_ratings" USING btree ("recipe_id","user_id");--> statement-breakpoint
CREATE INDEX "related_recipes_two_id_idx" ON "related_recipes" USING btree ("recipe_two_id");--> statement-breakpoint
CREATE INDEX "recipe_ingredients_recipe_id_idx" ON "recipe_ingredients" USING btree ("recipe_id");--> statement-breakpoint
CREATE INDEX "recipe_ingredients_ingredient_id_idx" ON "recipe_ingredients" USING btree ("ingredient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_method_recipe_step_unique" ON "recipe_method" USING btree ("recipe_id","step_number");--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_sources_household_name_unique" ON "recipe_sources" USING btree ("household_id","name");--> statement-breakpoint
CREATE INDEX "recipes_household_id_idx" ON "recipes" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "recipes_name_trgm_idx" ON "recipes" USING gin (lower("name") gin_trgm_ops);