-- Normalized name (lowercase, no accents) with a leading space, for word-prefix search
-- (LIKE '% prefix%'). See src/lib/search-text.ts. Backfill: npm run db:backfill-name-search.
ALTER TABLE users ADD COLUMN name_search TEXT;
