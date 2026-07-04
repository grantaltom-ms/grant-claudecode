create table if not exists public.daily_priority_suggestions (
  id uuid primary key default gen_random_uuid(),
  owner_email text not null,
  suggestion_date date not null,
  status text not null default 'suggested',
  title text not null,
  activity text not null,
  why_this_matters text,
  first_step text,
  suggested_time_block text,
  evidence jsonb not null default '[]'::jsonb,
  runners_up jsonb not null default '[]'::jsonb,
  scoring jsonb not null default '{}'::jsonb,
  raw_model_output jsonb not null default '{}'::jsonb,
  slack_channel_id text,
  slack_message_ts text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_email, suggestion_date)
);

create index if not exists daily_priority_suggestions_owner_date_idx
  on public.daily_priority_suggestions (owner_email, suggestion_date desc);

alter table public.daily_priority_suggestions enable row level security;

revoke all on table public.daily_priority_suggestions from anon, authenticated;
grant all on table public.daily_priority_suggestions to service_role;
