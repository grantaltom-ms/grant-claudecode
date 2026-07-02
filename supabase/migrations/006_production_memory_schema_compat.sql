create extension if not exists pgcrypto;

alter table public.email_threads
  add column if not exists latest_subject text,
  add column if not exists participant_emails jsonb not null default '[]'::jsonb,
  add column if not exists participant_names jsonb not null default '[]'::jsonb,
  add column if not exists last_graph_message_id text,
  add column if not exists open_items jsonb not null default '[]'::jsonb,
  add column if not exists status text not null default 'active',
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists summary_updated_at timestamptz;

alter table public.digest_runs
  add column if not exists run_started_at timestamptz not null default now(),
  add column if not exists run_completed_at timestamptz,
  add column if not exists saved_emails integer not null default 0,
  add column if not exists included_count integer not null default 0,
  add column if not exists status text not null default 'started',
  add column if not exists error_message text,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists updated_at timestamptz not null default now();

alter table public.digest_items
  add column if not exists graph_message_id text,
  add column if not exists graph_conversation_id text,
  add column if not exists sender_name text,
  add column if not exists sender_email text,
  add column if not exists subject text,
  add column if not exists received_at timestamptz,
  add column if not exists raw_digest_input jsonb not null default '{}'::jsonb,
  add column if not exists updated_at timestamptz not null default now();

create table if not exists public.entities (
  id uuid primary key default gen_random_uuid(),
  owner_email text not null,
  entity_type text not null,
  name text not null,
  normalized_name text not null,
  current_summary text,
  metadata jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.entity_mentions
  add column if not exists graph_message_id text,
  add column if not exists graph_conversation_id text,
  add column if not exists source_type text not null default 'email_preview',
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.entity_mentions
  drop constraint if exists entity_mentions_entity_id_fkey;

alter table public.entity_mentions
  add constraint entity_mentions_entity_id_fkey
  foreign key (entity_id) references public.entities(id) on delete cascade;

create index if not exists email_threads_owner_last_message_idx
  on public.email_threads (owner_email, last_message_at desc);

create index if not exists email_threads_status_idx
  on public.email_threads (status);

create index if not exists digest_runs_owner_started_idx
  on public.digest_runs (owner_email, run_started_at desc);

create index if not exists digest_runs_slack_thread_ts_idx
  on public.digest_runs (slack_thread_ts);

create index if not exists digest_items_graph_message_id_idx
  on public.digest_items (graph_message_id);

create index if not exists digest_items_graph_conversation_id_idx
  on public.digest_items (graph_conversation_id);

create unique index if not exists digest_items_run_item_idx
  on public.digest_items (digest_run_id, item_number);

create unique index if not exists digest_items_run_message_idx
  on public.digest_items (digest_run_id, graph_message_id);

create unique index if not exists entities_owner_type_normalized_name_idx
  on public.entities (owner_email, entity_type, normalized_name);

create index if not exists entities_owner_type_idx
  on public.entities (owner_email, entity_type, last_seen_at desc);

create index if not exists entity_mentions_graph_message_idx
  on public.entity_mentions (graph_message_id);

create index if not exists entity_mentions_graph_conversation_idx
  on public.entity_mentions (graph_conversation_id);

create unique index if not exists entity_mentions_entity_graph_source_idx
  on public.entity_mentions (entity_id, graph_message_id, source_type);

alter table public.entities enable row level security;
