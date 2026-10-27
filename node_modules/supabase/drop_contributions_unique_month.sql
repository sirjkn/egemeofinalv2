-- Run this in Supabase Dashboard → SQL Editor
-- Drops any unique constraint on (shareholder_id, month, year) from the contributions table

DO $$
DECLARE
  r RECORD;
BEGIN
  -- Drop by known name first
  ALTER TABLE contributions DROP CONSTRAINT IF EXISTS contributions_unique_month;

  -- Also find and drop any other unique constraint covering (shareholder_id, month, year)
  FOR r IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'contributions'::regclass
      AND contype = 'u'
      AND conkey @> ARRAY(
        SELECT attnum FROM pg_attribute
        WHERE attrelid = 'contributions'::regclass
          AND attname IN ('shareholder_id','month','year')
      )
  LOOP
    EXECUTE 'ALTER TABLE contributions DROP CONSTRAINT IF EXISTS ' || quote_ident(r.conname);
    RAISE NOTICE 'Dropped constraint: %', r.conname;
  END LOOP;
END $$;
