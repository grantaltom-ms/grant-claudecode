create extension if not exists pgcrypto;

create table if not exists public.digest_runs (
  id uuid primary key default gen_random_uuid(),
  owner_email text not null,
  slack_channel_id text not null,
  slack_thread_ts text,
  run_started_at timestamptz not null default now(),
  run_completed_at timestamptz,
  total_emails integer not null default 0,
  saved_emails integer not null default 0,
  included_count integer not null default 0,
  actionable_count integer not null default 0,
  archived_count integer not null default 0,
  status text not null default 'started',
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.digest_items (
  id uuid primary key default gen_random_uuid(),
  digest_run_id uuid not null references public.digest_runs(id) on delete cascade,
  item_number integer not null,
  graph_message_id text not null,
  graph_conversation_id text,
  sender_name text,
  sender_email text,
  subject text,
  received_at timestamptz,
  classification text not null default 'digest_candidate',
  action_status text not null default 'open',
  raw_digest_input jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (digest_run_id, item_number),
  unique (digest_run_id, graph_message_id)
);

create index if not exists digest_runs_owner_started_idx
  on public.digest_runs (owner_email, run_started_at desc);

create index if not exists digest_runs_slack_thread_ts_idx
  on public.digest_runs (slack_thread_ts);

create index if not exists digest_items_graph_message_id_idx
  on public.digest_items (graph_message_id);

create index if not exists digest_items_graph_conversation_id_idx
  on public.digest_items (graph_conversation_id);

alter table public.digest_runs enable row level security;
alter table public.digest_items enable row level security;
