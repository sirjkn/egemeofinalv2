-- Staff phone login support.
-- Run once in Supabase Dashboard -> SQL Editor.

alter table public.user_profiles
  add column if not exists phone text;

create unique index if not exists user_profiles_phone_unique_idx
  on public.user_profiles (phone)
  where phone is not null and btrim(phone) <> '';
