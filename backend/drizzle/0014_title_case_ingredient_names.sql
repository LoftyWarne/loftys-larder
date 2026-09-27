--> data migration: backfill ingredient names to match the title-case transform
--> on `ingredientNameSchema`. Mirrors `toTitleCase` — upper-case the first
--> character of each space-separated word, leave the rest untouched — so
--> `initcap` (which lower-cases the tail, mangling "BBQ") is not used.
UPDATE "ingredients" AS i
  SET "name" = t."name"
  FROM (
    SELECT src."id", string_agg(upper(left(w.word, 1)) || substr(w.word, 2), ' ' ORDER BY w.ord) AS "name"
    FROM "ingredients" AS src
    CROSS JOIN LATERAL regexp_split_to_table(src."name", ' ') WITH ORDINALITY AS w(word, ord)
    GROUP BY src."id"
  ) AS t
  WHERE t."id" = i."id" AND t."name" IS DISTINCT FROM i."name";
