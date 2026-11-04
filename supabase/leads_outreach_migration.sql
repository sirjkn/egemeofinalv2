-- Leads: Site Visits and Daily Outreach Log
-- Run once in Supabase Dashboard -> SQL Editor.

create table if not exists public.lead_site_visits (
  id bigserial primary key,
  project_id bigint references public.projects(id) on delete set null,
  location text not null,
  scheduled_at timestamptz not null,
  capacity integer not null check (capacity > 0),
  contacts_count integer check (contacts_count is null or contacts_count >= 0),
  details text,
  reported_by text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.lead_outreach_logs (
  id bigserial primary key,
  occurred_at timestamptz not null,
  activity_type text not null,
  contact_id bigint not null references public.lead_contacts(id) on delete restrict,
  outcome text not null,
  status text not null,
  reported_by text not null,
  reported_by_user_id uuid references auth.users(id) on delete set null,
  project_id bigint references public.projects(id) on delete set null,
  site_visit_id bigint references public.lead_site_visits(id) on delete set null,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists lead_site_visits_scheduled_at_idx
  on public.lead_site_visits (scheduled_at desc);
create index if not exists lead_outreach_logs_occurred_at_idx
  on public.lead_outreach_logs (occurred_at desc);
create index if not exists lead_outreach_logs_contact_id_idx
  on public.lead_outreach_logs (contact_id);

alter table public.lead_site_visits enable row level security;
alter table public.lead_outreach_logs enable row level security;

drop policy if exists "Authenticated users manage lead site visits" on public.lead_site_visits;
create policy "Authenticated users manage lead site visits"
  on public.lead_site_visits
  for all
  to authenticated
  using (true)
  with check (true);

drop policy if exists "Authenticated users manage outreach logs" on public.lead_outreach_logs;
create policy "Authenticated users manage outreach logs"
  on public.lead_outreach_logs
  for all
  to authenticated
  using (true)
  with check (true);

-- Expanded outreach workflow fields (safe to run more than once)
alter table public.lead_site_visits add column if not exists contact_id bigint references public.lead_contacts(id) on delete set null;
alter table public.lead_site_visits add column if not exists visitors_count integer;
alter table public.lead_site_visits add column if not exists transport text;
alter table public.lead_site_visits add column if not exists pickup_point text;
alter table public.lead_site_visits add column if not exists visit_outcome text;

alter table public.lead_outreach_logs add column if not exists activity_subtype text;
alter table public.lead_outreach_logs add column if not exists activity_purpose text;
alter table public.lead_outreach_logs add column if not exists contact_type text;
alter table public.lead_outreach_logs add column if not exists pipeline_stage text;
alter table public.lead_outreach_logs add column if not exists plot_reference text;
alter table public.lead_outreach_logs add column if not exists budget_range text;
alter table public.lead_outreach_logs add column if not exists payment_preference text;
alter table public.lead_outreach_logs add column if not exists lost_reason text;
alter table public.lead_outreach_logs add column if not exists followup_at timestamptz;
alter table public.lead_outreach_logs add column if not exists followup_type text;
alter table public.lead_outreach_logs add column if not exists assigned_to uuid references auth.users(id) on delete set null;
alter table public.lead_outreach_logs add column if not exists assigned_to_name text;
alter table public.lead_outreach_logs add column if not exists priority text;
alter table public.lead_outreach_logs add column if not exists remind_via text[] not null default '{}';
alter table public.lead_outreach_logs add column if not exists reminder_status text;
alter table public.lead_outreach_logs add column if not exists linked_log_id bigint references public.lead_outreach_logs(id) on delete set null;
alter table public.lead_outreach_logs add column if not exists metadata jsonb not null default '{}'::jsonb;

create index if not exists lead_outreach_logs_followup_at_idx
  on public.lead_outreach_logs (followup_at)
  where reminder_status = 'open';
