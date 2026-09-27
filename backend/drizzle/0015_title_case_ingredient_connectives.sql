--> data migration: re-backfill ingredient names for the revised `toTitleCase`
--> rule. Leading punctuation is skipped ("(prawn" → "(Prawn") and "and" / "or"
--> stay lower-case unless they open the name. Supersedes 0014's output.
UPDATE "ingredients" AS i
  SET "name" = t."name"
  FROM (
    SELECT src."id", string_agg(
      CASE
        WHEN w.ord > 1 AND lower(regexp_replace(w.word, '^[^[:alpha:]]+|[^[:alpha:]]+$', '', 'g')) IN ('and', 'or')
          THEN lower(w.word)
        ELSE p.prefix || upper(left(substr(w.word, length(p.prefix) + 1), 1)) || substr(w.word, length(p.prefix) + 2)
      END, ' ' ORDER BY w.ord) AS "name"
    FROM "ingredients" AS src
    CROSS JOIN LATERAL regexp_split_to_table(src."name", ' ') WITH ORDINALITY AS w(word, ord)
    CROSS JOIN LATERAL (SELECT coalesce(substring(w.word FROM '^[^[:alnum:]]*'), '') AS prefix) AS p
    GROUP BY src."id"
  ) AS t
  WHERE t."id" = i."id" AND t."name" IS DISTINCT FROM i."name";
