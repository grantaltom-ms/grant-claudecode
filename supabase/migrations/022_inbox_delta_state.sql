create table if not exists public.inbox_delta_state (
  owner_email text primary key,
  cursor_url text,
  is_bootstrapped boolean not null default false,
  last_resync_at timestamptz,
  last_resync_reason text,
  updated_at timestamptz not null default now()
);

alter table public.inbox_delta_state enable row level security;

revoke all on table public.inbox_delta_state from anon, authenticated;
grant all on table public.inbox_delta_state to service_role;
