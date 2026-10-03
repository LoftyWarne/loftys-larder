CREATE TABLE "recipe_health_scores" (
	"recipe_id" integer PRIMARY KEY NOT NULL,
	"score" smallint NOT NULL,
	"summary" text,
	"model" text NOT NULL,
	"scored_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_stale" boolean DEFAULT false NOT NULL,
	CONSTRAINT "recipe_health_scores_score_range" CHECK ("recipe_health_scores"."score" BETWEEN 1 AND 10)
);
--> statement-breakpoint
ALTER TABLE "recipe_health_scores" ADD CONSTRAINT "recipe_health_scores_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE restrict ON UPDATE no action;