-- ─── Plot assigning date & contract expiry ──────────────────────────────────
-- Run once in Supabase Dashboard → SQL Editor.
-- assigned_at:     the date a plot was assigned to its owner (set in Assign / Edit plot).
--                  Arrears use it as the allocation date: the first monthly repayment
--                  falls due in the month after this date.
-- contract_expiry: the contract end date entered in Assign / Edit plot (any day; the
--                  payment duration in months is derived from it).

alter table public.plots add column if not exists assigned_at date;
alter table public.plots add column if not exists contract_expiry date;
