create extension if not exists pgcrypto;

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
  updated_at timestamptz not null default now(),
  unique (owner_email, entity_type, normalized_name)
);

create table if not exists public.entity_mentions (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id) on delete cascade,
  graph_message_id text,
  graph_conversation_id text,
  source_type text not null default 'email_preview',
  mention_text text,
  confidence numeric(4, 3),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (entity_id, graph_message_id, source_type)
);

create index if not exists entities_owner_type_idx
  on public.entities (owner_email, entity_type, last_seen_at desc);

create index if not exists entity_mentions_graph_message_idx
  on public.entity_mentions (graph_message_id);

create index if not exists entity_mentions_graph_conversation_idx
  on public.entity_mentions (graph_conversation_id);

alter table public.entities enable row level security;
alter table public.entity_mentions enable row level security;
