-- ─────────────────────────────────────────────────────────────────────────────
-- Add photo_url + make member_number user-editable on all member tables
-- ─────────────────────────────────────────────────────────────────────────────

-- Photo URL column (stores path like /uploads/abc123.jpg)
ALTER TABLE shareholders ADD COLUMN IF NOT EXISTS photo_url VARCHAR(500);
ALTER TABLE clients      ADD COLUMN IF NOT EXISTS photo_url VARCHAR(500);
ALTER TABLE investors    ADD COLUMN IF NOT EXISTS photo_url VARCHAR(500);

-- Remove sequence default so member_number can be set manually.
-- The server will call nextval() itself when the user leaves it blank.
ALTER TABLE shareholders ALTER COLUMN member_number DROP DEFAULT;
ALTER TABLE clients      ALTER COLUMN member_number DROP DEFAULT;
ALTER TABLE investors    ALTER COLUMN member_number DROP DEFAULT;

-- Unique constraint on member_number per table (skip if already exists)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shareholders_member_number_key'
  ) THEN
    ALTER TABLE shareholders ADD CONSTRAINT shareholders_member_number_key UNIQUE (member_number);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'clients_member_number_key'
  ) THEN
    ALTER TABLE clients ADD CONSTRAINT clients_member_number_key UNIQUE (member_number);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'investors_member_number_key'
  ) THEN
    ALTER TABLE investors ADD CONSTRAINT investors_member_number_key UNIQUE (member_number);
  END IF;
END $$;
