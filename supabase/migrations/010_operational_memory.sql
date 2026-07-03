create extension if not exists pgcrypto;

create table if not exists public.memory_projects (
  id uuid primary key default gen_random_uuid(),
  owner_email text not null,
  name text not null,
  normalized_name text not null,
  status text not null default 'active',
  summary text,
  related_entity_id uuid references public.entities(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_email, normalized_name)
);

create table if not exists public.decisions (
  id uuid primary key default gen_random_uuid(),
  owner_email text not null,
  title text not null,
  decision text not null,
  status text not null default 'active',
  decided_at timestamptz,
  source_thread_id uuid references public.email_threads(id) on delete set null,
  source_message_id uuid references public.email_messages(id) on delete set null,
  related_entity_id uuid references public.entities(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.commitments (
  id uuid primary key default gen_random_uuid(),
  owner_email text not null,
  title text not null,
  commitment text not null,
  owner_name text,
  due_at timestamptz,
  status text not null default 'open',
  source_thread_id uuid references public.email_threads(id) on delete set null,
  source_message_id uuid references public.email_messages(id) on delete set null,
  related_entity_id uuid references public.entities(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.open_loops (
  id uuid primary key default gen_random_uuid(),
  owner_email text not null,
  title text not null,
  description text,
  status text not null default 'open',
  priority text not null default 'normal',
  due_at timestamptz,
  source_thread_id uuid references public.email_threads(id) on delete set null,
  source_message_id uuid references public.email_messages(id) on delete set null,
  related_entity_id uuid references public.entities(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.agent_actions (
  id uuid primary key default gen_random_uuid(),
  owner_email text not null,
  action_type text not null,
  status text not null default 'started',
  tool_name text,
  slack_thread_ts text,
  graph_message_id text,
  graph_conversation_id text,
  input jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists decisions_owner_title_thread_idx
  on public.decisions (owner_email, title, source_thread_id);

create unique index if not exists commitments_owner_title_thread_idx
  on public.commitments (owner_email, title, source_thread_id);

create unique index if not exists open_loops_owner_title_thread_idx
  on public.open_loops (owner_email, title, source_thread_id);

create index if not exists memory_projects_owner_status_idx
  on public.memory_projects (owner_email, status, last_seen_at desc);

create index if not exists decisions_owner_created_idx
  on public.decisions (owner_email, created_at desc);

create index if not exists commitments_owner_status_due_idx
  on public.commitments (owner_email, status, due_at);

create index if not exists open_loops_owner_status_priority_idx
  on public.open_loops (owner_email, status, priority, updated_at desc);

create index if not exists agent_actions_owner_created_idx
  on public.agent_actions (owner_email, created_at desc);

alter table public.memory_projects enable row level security;
alter table public.decisions enable row level security;
alter table public.commitments enable row level security;
alter table public.open_loops enable row level security;
alter table public.agent_actions enable row level security;
