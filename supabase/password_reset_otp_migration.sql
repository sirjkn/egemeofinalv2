-- ─── Server-side password reset codes ────────────────────────────────────────
-- Run once in Supabase Dashboard → SQL Editor, BEFORE deploying the updated
-- admin-reset-password function.
--
-- Stores a SHA-256 hash of each 6-digit reset code (never the code itself).
-- RLS enabled with no policies: only the edge function (service role) can access it.

create table if not exists public.password_reset_otps (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  code_hash  text not null,
  attempts   integer not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists password_reset_otps_user_idx on public.password_reset_otps (user_id);

alter table public.password_reset_otps enable row level security;
