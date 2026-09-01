create table if not exists public.calendar_event_drafts (
  id uuid primary key default gen_random_uuid(),
  owner_email text not null,
  action text not null default 'create',
  target_event_id text,
  subject text,
  start_time timestamptz,
  end_time timestamptz,
  time_zone text not null default 'America/Los_Angeles',
  location text,
  body text,
  attendees jsonb not null default '[]'::jsonb,
  cancel_comment text,
  source_message_id text,
  status text not null default 'pending',
  graph_event_id text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists calendar_event_drafts_owner_status_idx
  on public.calendar_event_drafts (owner_email, status, created_at desc);

alter table public.calendar_event_drafts enable row level security;

revoke all on table public.calendar_event_drafts from anon, authenticated;
grant all on table public.calendar_event_drafts to service_role;
