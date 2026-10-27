-- Add deadline column to plots table
-- Run this in Supabase Dashboard → SQL Editor

ALTER TABLE plots ADD COLUMN IF NOT EXISTS deadline DATE;
