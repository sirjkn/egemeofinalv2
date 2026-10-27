-- =============================================================================
-- Egemeo Ardhi SACCO – Supabase Setup
-- Run this in: Supabase Dashboard → SQL Editor → New query → Run
-- =============================================================================

-- ─── Shareholders ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shareholders (
  id                  BIGSERIAL PRIMARY KEY,
  member_number       INTEGER      NOT NULL UNIQUE,
  name                TEXT         NOT NULL,
  phone               TEXT         NOT NULL UNIQUE,
  email               TEXT,
  id_passport         TEXT,
  joined_date         DATE         NOT NULL DEFAULT CURRENT_DATE,
  status              TEXT         NOT NULL DEFAULT 'Active',
  avatar_color        TEXT         NOT NULL DEFAULT '#14b8a6',
  photo_url           TEXT,
  net_savings         NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_profits       NUMERIC(14,2) NOT NULL DEFAULT 0,
  contributions_count INTEGER       NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─── Clients ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clients (
  id            BIGSERIAL PRIMARY KEY,
  member_number TEXT         NOT NULL UNIQUE,
  name          TEXT         NOT NULL,
  phone         TEXT         NOT NULL UNIQUE,
  email         TEXT,
  id_passport   TEXT,
  joined_date   DATE         NOT NULL DEFAULT CURRENT_DATE,
  status        TEXT         NOT NULL DEFAULT 'Active',
  avatar_color  TEXT         NOT NULL DEFAULT '#a855f7',
  photo_url     TEXT,
  loan_balance  NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─── Investors ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS investors (
  id                BIGSERIAL PRIMARY KEY,
  member_number     INTEGER      NOT NULL UNIQUE,
  name              TEXT         NOT NULL,
  phone             TEXT         NOT NULL UNIQUE,
  email             TEXT,
  id_passport       TEXT,
  joined_date       DATE         NOT NULL DEFAULT CURRENT_DATE,
  status            TEXT         NOT NULL DEFAULT 'Active',
  avatar_color      TEXT         NOT NULL DEFAULT '#eab308',
  photo_url         TEXT,
  investment_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─── Contributions ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contributions (
  id             BIGSERIAL PRIMARY KEY,
  shareholder_id BIGINT       NOT NULL REFERENCES shareholders(id) ON DELETE CASCADE,
  amount         NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  month          INTEGER      NOT NULL CHECK (month BETWEEN 1 AND 12),
  year           INTEGER      NOT NULL,
  payment_date   DATE,
  status         TEXT         NOT NULL DEFAULT 'paid',  -- 'paid' | 'late'
  notes          TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS contributions_shareholder_idx ON contributions (shareholder_id);
CREATE INDEX IF NOT EXISTS contributions_year_month_idx  ON contributions (year, month);
CREATE UNIQUE INDEX IF NOT EXISTS contributions_unique_month ON contributions (shareholder_id, month, year);

-- ─── Payments ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id             BIGSERIAL PRIMARY KEY,
  payment_id     TEXT,                   -- Mpesa TXN code or manual reference
  date_paid      DATE          NOT NULL DEFAULT CURRENT_DATE,
  amount         NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  paid_by        TEXT          NOT NULL,
  purpose        TEXT          NOT NULL DEFAULT 'general',
  mode           TEXT          NOT NULL DEFAULT 'cash',
  comment        TEXT,
  shareholder_id BIGINT        REFERENCES shareholders(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS payments_date_idx    ON payments (date_paid);
CREATE INDEX IF NOT EXISTS payments_mode_idx    ON payments (mode);
CREATE INDEX IF NOT EXISTS payments_purpose_idx ON payments (purpose);

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all payments" ON payments;
CREATE POLICY "Allow all payments" ON payments FOR ALL TO anon USING (true) WITH CHECK (true);

-- ─── Refunds ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refunds (
  id             BIGSERIAL PRIMARY KEY,
  shareholder_id BIGINT        NOT NULL REFERENCES shareholders(id) ON DELETE CASCADE,
  amount         NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  refund_date    DATE          NOT NULL DEFAULT CURRENT_DATE,
  notes          TEXT,
  processed_by   TEXT,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS refunds_shareholder_idx ON refunds (shareholder_id);

-- ─── Row Level Security: allow full access to anon key ───────────────────────
ALTER TABLE shareholders ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients      ENABLE ROW LEVEL SECURITY;
ALTER TABLE investors    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all shareholders" ON shareholders;
CREATE POLICY "Allow all shareholders" ON shareholders FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all clients" ON clients;
CREATE POLICY "Allow all clients" ON clients FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all investors" ON investors;
CREATE POLICY "Allow all investors" ON investors FOR ALL TO anon USING (true) WITH CHECK (true);

ALTER TABLE contributions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all contributions" ON contributions;
CREATE POLICY "Allow all contributions" ON contributions FOR ALL TO anon USING (true) WITH CHECK (true);

ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all refunds" ON refunds;
CREATE POLICY "Allow all refunds" ON refunds FOR ALL TO anon USING (true) WITH CHECK (true);

-- ─── Projects ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id              BIGSERIAL PRIMARY KEY,
  project_name    TEXT          NOT NULL,
  location        TEXT          NOT NULL DEFAULT '',
  size_acres      NUMERIC(10,2) NOT NULL DEFAULT 0,
  number_of_plots INTEGER       NOT NULL DEFAULT 0,
  project_cost    NUMERIC(14,2) NOT NULL DEFAULT 0,
  net_profit      NUMERIC(14,2) NOT NULL DEFAULT 0,
  date_started    DATE,
  date_completed  DATE,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all projects" ON projects;
CREATE POLICY "Allow all projects" ON projects FOR ALL TO anon USING (true) WITH CHECK (true);

-- ─── Plots ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plots (
  id                   BIGSERIAL PRIMARY KEY,
  project_id           BIGINT        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plot_number          TEXT          NOT NULL,
  price                NUMERIC(14,2) NOT NULL DEFAULT 0,
  size                 NUMERIC(10,4) NOT NULL DEFAULT 0,
  status               TEXT          NOT NULL DEFAULT 'available',
  assigned_to_id       BIGINT,
  assigned_to_type     TEXT,
  payment_mode         TEXT,
  loan_duration_months INTEGER,
  interest_type        TEXT,
  interest_amount      NUMERIC(14,2),
  paid_amount          NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS plots_project_idx ON plots (project_id);
CREATE INDEX IF NOT EXISTS plots_assigned_idx ON plots (assigned_to_id, assigned_to_type);

ALTER TABLE plots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all plots" ON plots;
CREATE POLICY "Allow all plots" ON plots FOR ALL TO anon USING (true) WITH CHECK (true);

-- ─── Project Shareholders (enrolled) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_shareholders (
  id             BIGSERIAL PRIMARY KEY,
  project_id     BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  shareholder_id BIGINT NOT NULL REFERENCES shareholders(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, shareholder_id)
);

ALTER TABLE project_shareholders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all project_shareholders" ON project_shareholders;
CREATE POLICY "Allow all project_shareholders" ON project_shareholders FOR ALL TO anon USING (true) WITH CHECK (true);

-- ─── Profit Distributions ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profit_distributions (
  id             BIGSERIAL PRIMARY KEY,
  project_id     BIGINT        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  shareholder_id BIGINT        NOT NULL REFERENCES shareholders(id) ON DELETE CASCADE,
  amount         NUMERIC(14,2) NOT NULL DEFAULT 0,
  distributed_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  notes          TEXT
);

CREATE INDEX IF NOT EXISTS profit_dist_project_idx     ON profit_distributions (project_id);
CREATE INDEX IF NOT EXISTS profit_dist_shareholder_idx ON profit_distributions (shareholder_id);

ALTER TABLE profit_distributions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all profit_distributions" ON profit_distributions;
CREATE POLICY "Allow all profit_distributions" ON profit_distributions FOR ALL TO anon USING (true) WITH CHECK (true);

-- ─── Plot Payments ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plot_payments (
  id           BIGSERIAL PRIMARY KEY,
  plot_id      BIGINT        NOT NULL REFERENCES plots(id) ON DELETE CASCADE,
  amount       NUMERIC(14,2) NOT NULL,
  notes        TEXT,
  payment_date DATE          NOT NULL DEFAULT CURRENT_DATE,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS plot_payments_plot_idx ON plot_payments (plot_id);

ALTER TABLE plot_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all plot_payments" ON plot_payments;
CREATE POLICY "Allow all plot_payments" ON plot_payments FOR ALL TO anon USING (true) WITH CHECK (true);

-- ─── Storage bucket for member photos ────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('member-photos', 'member-photos', true)
ON CONFLICT (id) DO NOTHING;

-- Allow public uploads and reads on member-photos bucket
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Public photo upload' AND tablename = 'objects') THEN
    CREATE POLICY "Public photo upload" ON storage.objects
      FOR INSERT TO anon WITH CHECK (bucket_id = 'member-photos');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Public photo read' AND tablename = 'objects') THEN
    CREATE POLICY "Public photo read" ON storage.objects
      FOR SELECT TO anon USING (bucket_id = 'member-photos');
  END IF;
END $$;

-- ─── Migration: add date_started / date_completed to projects ────────────────
ALTER TABLE projects ADD COLUMN IF NOT EXISTS date_started   DATE;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS date_completed DATE;

-- ─── Migration: allow investor profit distributions ───────────────────────────
ALTER TABLE profit_distributions ADD COLUMN IF NOT EXISTS investor_id BIGINT REFERENCES investors(id) ON DELETE CASCADE;
ALTER TABLE profit_distributions ALTER COLUMN shareholder_id DROP NOT NULL;

-- ─── Migration: add total_profits to investors ────────────────────────────────
ALTER TABLE investors ADD COLUMN IF NOT EXISTS total_profits NUMERIC(14,2) NOT NULL DEFAULT 0;

-- ─── Project Investments ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_investments (
  id          BIGSERIAL PRIMARY KEY,
  project_id  BIGINT        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  investor_id BIGINT        NOT NULL REFERENCES investors(id) ON DELETE CASCADE,
  amount      NUMERIC(14,2) NOT NULL,
  notes       TEXT,
  invested_at DATE          NOT NULL DEFAULT CURRENT_DATE,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS project_investments_project_idx  ON project_investments (project_id);
CREATE INDEX IF NOT EXISTS project_investments_investor_idx ON project_investments (investor_id);

ALTER TABLE project_investments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all project_investments" ON project_investments;
CREATE POLICY "Allow all project_investments" ON project_investments FOR ALL TO anon USING (true) WITH CHECK (true);

-- ─── App Settings (M-Pesa keys, SMS config, server URL) ──────────────────────
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all app_settings" ON app_settings;
CREATE POLICY "Allow all app_settings" ON app_settings FOR ALL TO anon USING (true) WITH CHECK (true);

-- ─── Project External Investments ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_investments (
  id          BIGSERIAL PRIMARY KEY,
  project_id  BIGINT        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  investor_id BIGINT        NOT NULL REFERENCES investors(id) ON DELETE CASCADE,
  amount      NUMERIC(14,2) NOT NULL,
  notes       TEXT,
  invested_at DATE          NOT NULL DEFAULT CURRENT_DATE,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS proj_invest_project_idx ON project_investments (project_id);
CREATE INDEX IF NOT EXISTS proj_invest_investor_idx ON project_investments (investor_id);

ALTER TABLE project_investments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all project_investments" ON project_investments;
CREATE POLICY "Allow all project_investments" ON project_investments FOR ALL TO anon USING (true) WITH CHECK (true);

-- ─── Migration: client numbers are text (e.g. EC001, EC002) ─────────────────
-- Run this ONCE if your clients table already has an INTEGER member_number column:
ALTER TABLE clients ALTER COLUMN member_number TYPE TEXT USING CAST(member_number AS TEXT);

-- ─── User Profiles (role-based access) ───────────────────────────────────────
-- Links Supabase Auth users to roles and member records
CREATE TABLE IF NOT EXISTS user_profiles (
  id         UUID          PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role       TEXT          NOT NULL CHECK (role IN ('admin','shareholder','client','investor')),
  member_id  BIGINT,
  full_name  TEXT          NOT NULL DEFAULT '',
  email      TEXT          NOT NULL DEFAULT '',
  is_active  BOOLEAN       NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all user_profiles" ON user_profiles;
CREATE POLICY "Allow all user_profiles" ON user_profiles FOR ALL TO anon USING (true) WITH CHECK (true);

-- ─── Migration: track first-login password change ────────────────────────────
-- Run this ONCE on an existing database:
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS password_changed BOOLEAN NOT NULL DEFAULT FALSE;
-- Mark existing admin accounts as already set up (skip password-change prompt)
UPDATE user_profiles SET password_changed = TRUE WHERE role = 'admin';

-- ─── First admin setup instructions ──────────────────────────────────────────
-- 1. Supabase Dashboard → Authentication → Settings → DISABLE "Enable email confirmations"
--    (critical — members are auto-provisioned on first login, needs instant account creation)
-- 2. Supabase Dashboard → Authentication → Users → Add user (email + password)
-- 3. Copy the new user's UUID and run:
--
--    INSERT INTO user_profiles (id, role, full_name, email, password_changed)
--    VALUES ('<uuid-from-step-2>', 'admin', 'Your Name', 'your@email.com', TRUE);
--
-- 4. Log in at your app URL with that email/password → you have full admin access.
-- 5. Members log in with their phone number (0712345678) + default password 123456
--    Their account is auto-created on first login — no manual setup needed.
-- 6. On first login, each member is prompted to set a personal password.


-- ─── Admin Password Reset Function ───────────────────────────────────────────
-- Allows admin to reset any member's password directly via supabase.rpc().
-- Requires pgcrypto (enabled by default on all Supabase projects).
-- Run once in: Supabase Dashboard → SQL Editor → New query → Run
CREATE OR REPLACE FUNCTION admin_reset_password(target_user_id UUID, new_password TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller_role TEXT;
BEGIN
  SELECT role INTO caller_role FROM user_profiles WHERE id = auth.uid();
  IF caller_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authorized');
  END IF;

  IF char_length(new_password) < 6 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Password must be at least 6 characters');
  END IF;

  UPDATE auth.users
  SET encrypted_password = crypt(new_password, gen_salt('bf')),
      updated_at = now()
  WHERE id = target_user_id;

  UPDATE user_profiles SET password_changed = false WHERE id = target_user_id;

  RETURN jsonb_build_object('success', true);
END;
$$;
