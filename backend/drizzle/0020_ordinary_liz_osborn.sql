CREATE TABLE "recipe_method_ingredients" (
	"method_step_id" integer NOT NULL,
	"ingredient_id" integer NOT NULL,
	"quantity" numeric(10, 3),
	CONSTRAINT "recipe_method_ingredients_method_step_id_ingredient_id_pk" PRIMARY KEY("method_step_id","ingredient_id"),
	CONSTRAINT "recipe_method_ingredients_quantity_positive" CHECK ("recipe_method_ingredients"."quantity" IS NULL OR "recipe_method_ingredients"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "recipe_method_ingredients" ADD CONSTRAINT "recipe_method_ingredients_method_step_id_recipe_method_id_fk" FOREIGN KEY ("method_step_id") REFERENCES "public"."recipe_method"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_method_ingredients" ADD CONSTRAINT "recipe_method_ingredients_ingredient_id_ingredients_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recipe_method_ingredients_ingredient_id_idx" ON "recipe_method_ingredients" USING btree ("ingredient_id");--> statement-breakpoint
-- One-off, best-effort fill for existing recipes (DEC-99): link each method
-- step to the recipe's ingredients its text names. Names lose bracketed parts
-- and may take an s/es plural. Longer names claim their text first, so "black
-- pepper" doesn't also tag a separate "Pepper". A last-word fallback
-- ("potatoes" -> Sweet Potato) applies only when no other ingredient in the
-- recipe uses that word. Amounts are left blank.
DO $$
DECLARE
  step record;
  ing record;
  remaining text;
  pattern text;
BEGIN
  FOR step IN SELECT id, recipe_id, instruction FROM recipe_method LOOP
    remaining := step.instruction;

    FOR ing IN
      WITH names AS (
        SELECT DISTINCT
          ri.ingredient_id,
          lower(btrim(regexp_replace(
            regexp_replace(i.name, '\([^)]*\)', ' ', 'g'), '\s+', ' ', 'g'
          ))) AS clean
        FROM recipe_ingredients ri
        JOIN ingredients i ON i.id = ri.ingredient_id
        WHERE ri.recipe_id = step.recipe_id
      )
      SELECT ingredient_id, clean AS term
      FROM names
      WHERE clean <> ''
      ORDER BY length(clean) DESC, ingredient_id
    LOOP
      pattern := '(^|[^[:alnum:]])'
        || replace(
          regexp_replace(ing.term, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g'),
          ' ', '[[:space:]]+'
        )
        || '(e?s)?($|[^[:alnum:]])';
      IF remaining ~* pattern THEN
        INSERT INTO recipe_method_ingredients (method_step_id, ingredient_id)
        VALUES (step.id, ing.ingredient_id)
        ON CONFLICT DO NOTHING;
        remaining := regexp_replace(remaining, pattern, '\1 \3', 'gi');
      END IF;
    END LOOP;

    FOR ing IN
      WITH names AS (
        SELECT DISTINCT
          ri.ingredient_id,
          lower(btrim(regexp_replace(
            regexp_replace(i.name, '\([^)]*\)', ' ', 'g'), '\s+', ' ', 'g'
          ))) AS clean
        FROM recipe_ingredients ri
        JOIN ingredients i ON i.id = ri.ingredient_id
        WHERE ri.recipe_id = step.recipe_id
      ),
      last_words AS (
        SELECT ingredient_id, clean, substring(clean FROM '([^ ]+)$') AS word
        FROM names
        WHERE position(' ' IN clean) > 0
      )
      SELECT lw.ingredient_id, lw.word AS term
      FROM last_words lw
      WHERE NOT EXISTS (
          SELECT 1 FROM names o
          WHERE o.ingredient_id <> lw.ingredient_id
            AND (' ' || o.clean || ' ') LIKE ('% ' || lw.word || ' %')
        )
        AND NOT EXISTS (
          SELECT 1 FROM recipe_method_ingredients rmi
          WHERE rmi.method_step_id = step.id
            AND rmi.ingredient_id = lw.ingredient_id
        )
      ORDER BY length(lw.word) DESC, lw.ingredient_id
    LOOP
      pattern := '(^|[^[:alnum:]])'
        || regexp_replace(ing.term, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g')
        || '(e?s)?($|[^[:alnum:]])';
      IF remaining ~* pattern THEN
        INSERT INTO recipe_method_ingredients (method_step_id, ingredient_id)
        VALUES (step.id, ing.ingredient_id)
        ON CONFLICT DO NOTHING;
        remaining := regexp_replace(remaining, pattern, '\1 \3', 'gi');
      END IF;
    END LOOP;
  END LOOP;
END $$;
