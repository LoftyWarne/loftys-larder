CREATE TABLE "recipe_tag_links" (
	"recipe_id" integer NOT NULL,
	"tag_id" integer NOT NULL,
	CONSTRAINT "recipe_tag_links_recipe_id_tag_id_pk" PRIMARY KEY("recipe_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "recipe_tags" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "recipe_tags_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "recipe_tags_name_length" CHECK (char_length("recipe_tags"."name") BETWEEN 1 AND 40)
);
--> statement-breakpoint
ALTER TABLE "recipe_tag_links" ADD CONSTRAINT "recipe_tag_links_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_tag_links" ADD CONSTRAINT "recipe_tag_links_tag_id_recipe_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."recipe_tags"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_tags" ADD CONSTRAINT "recipe_tags_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recipe_tag_links_tag_id_idx" ON "recipe_tag_links" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_tags_household_lower_name_unique" ON "recipe_tags" USING btree ("household_id",lower("name"));