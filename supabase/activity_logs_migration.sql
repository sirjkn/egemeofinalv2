-- Run this once in Supabase Dashboard → SQL Editor

create table if not exists activity_logs (
  id           bigserial primary key,
  category     text not null default 'other',
  action       text not null,
  description  text not null,
  actor_name   text,
  actor_role   text,
  meta         jsonb,
  created_at   timestamptz not null default now()
);

-- Allow anon & authenticated roles to insert and select (matches existing RLS style)
alter table activity_logs enable row level security;

create policy "allow_all_activity_logs" on activity_logs
  for all using (true) with check (true);

-- Index for fast date-range and actor queries
create index if not exists activity_logs_created_at_idx on activity_logs (created_at desc);
create index if not exists activity_logs_actor_idx      on activity_logs (actor_name);
create index if not exists activity_logs_category_idx   on activity_logs (category);
