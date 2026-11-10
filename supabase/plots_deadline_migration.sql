-- Add deadline column to plots table
-- Run this in Supabase Dashboard → SQL Editor

ALTER TABLE plots ADD COLUMN IF NOT EXISTS deadline DATE;
ALTER TABLE plots ADD COLUMN IF NOT EXISTS min_monthly_payment NUMERIC(12,2) DEFAULT NULL;
