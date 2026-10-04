CREATE TABLE "recipe_import_originals" (
	"recipe_id" integer NOT NULL,
	"position" smallint NOT NULL,
	"public_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_import_originals_recipe_id_position_pk" PRIMARY KEY("recipe_id","position"),
	CONSTRAINT "recipe_import_originals_position_nonnegative" CHECK ("recipe_import_originals"."position" >= 0)
);
--> statement-breakpoint
ALTER TABLE "recipe_import_originals" ADD CONSTRAINT "recipe_import_originals_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_import_originals_public_id_unique" ON "recipe_import_originals" USING btree ("public_id");