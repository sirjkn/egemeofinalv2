-- Run in Supabase Dashboard → SQL Editor

-- 0. DROP the unique monthly constraint so multiple contributions per month are allowed
ALTER TABLE contributions DROP CONSTRAINT IF EXISTS contributions_unique_month;

-- 1. Add penalty columns to contributions
ALTER TABLE contributions
  ADD COLUMN IF NOT EXISTS penalty_amount  NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS penalty_status  TEXT          DEFAULT 'unpaid'
    CHECK (penalty_status IN ('unpaid','paid','waived','none'));

-- 2. Add penalty columns to plot_payments
ALTER TABLE plot_payments
  ADD COLUMN IF NOT EXISTS penalty_amount  NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS penalty_status  TEXT          DEFAULT 'unpaid'
    CHECK (penalty_status IN ('unpaid','paid','waived','none'));

-- 3. Add min_monthly_payment column to plots
ALTER TABLE plots
  ADD COLUMN IF NOT EXISTS min_monthly_payment NUMERIC(12,2) DEFAULT NULL;

-- 4. Insert default payment rules into app_settings (safe upsert)
INSERT INTO app_settings (key, value, updated_at)
VALUES (
  'payment_rules',
  '{
    "contribution_deadline_day": 5,
    "contribution_penalty_amount": 500,
    "contribution_penalty_type": "flat",
    "minimum_contribution_amount": 0,
    "plot_grace_days": 5,
    "plot_penalty_amount": 500,
    "plot_penalty_type": "flat"
  }'::jsonb,
  now()
)
ON CONFLICT (key) DO NOTHING;
