create extension if not exists pgcrypto;

create table if not exists public.email_threads (
  id uuid primary key default gen_random_uuid(),
  graph_conversation_id text not null unique,
  owner_email text not null,
  latest_subject text,
  participant_emails jsonb not null default '[]'::jsonb,
  participant_names jsonb not null default '[]'::jsonb,
  first_message_at timestamptz,
  last_message_at timestamptz,
  last_graph_message_id text,
  message_count integer not null default 0,
  current_summary text,
  open_items jsonb not null default '[]'::jsonb,
  status text not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists email_threads_owner_last_message_idx
  on public.email_threads (owner_email, last_message_at desc);

create index if not exists email_threads_status_idx
  on public.email_threads (status);

alter table public.email_threads enable row level security;
