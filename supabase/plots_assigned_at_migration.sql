-- ─── Plot assigning date ─────────────────────────────────────────────────────
-- Run once in Supabase Dashboard → SQL Editor.
-- Stores the date a plot was assigned to its owner (set in Assign / Edit plot).
-- Arrears use it as the allocation date: the first monthly repayment falls due
-- in the month after this date.

alter table public.plots add column if not exists assigned_at date;
