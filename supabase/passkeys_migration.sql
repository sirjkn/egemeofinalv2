-- ─── Biometric (passkey / WebAuthn) login ────────────────────────────────────
-- Run once in Supabase Dashboard → SQL Editor.
--
-- user_passkeys      one row per device a user enabled fingerprint/face login on.
--                    Stores only the PUBLIC key; the private key never leaves the phone.
-- passkey_challenges short-lived random challenges used during enable/login.
--
-- RLS is enabled with NO policies: the browser cannot read or write these tables.
-- Only the `passkey` edge function (service role) touches them.

create table if not exists public.user_passkeys (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  credential_id text not null unique,          -- base64url
  public_key    text not null,                 -- base64url COSE public key
  counter       bigint not null default 0,
  transports    text[] not null default '{}',
  device_name   text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index if not exists user_passkeys_user_idx on public.user_passkeys (user_id);

create table if not exists public.passkey_challenges (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id) on delete cascade,  -- null for login
  kind       text not null check (kind in ('register', 'login')),
  challenge  text not null,
  rp_id      text not null,
  origin     text not null,
  expires_at timestamptz not null default (now() + interval '5 minutes'),
  created_at timestamptz not null default now()
);
create index if not exists passkey_challenges_expires_idx on public.passkey_challenges (expires_at);

alter table public.user_passkeys      enable row level security;
alter table public.passkey_challenges enable row level security;
