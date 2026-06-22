-- Runs once, the first time the named volume is initialised.
-- Executes in the context of POSTGRES_DB (lofty_dev by default).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE DATABASE lofty_test;

\connect lofty_test

CREATE EXTENSION IF NOT EXISTS pg_trgm;

\connect lofty_dev

CREATE DATABASE lofty_e2e;

\connect lofty_e2e

CREATE EXTENSION IF NOT EXISTS pg_trgm;
