create extension if not exists pgcrypto;

create table if not exists public.email_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid references public.email_messages(id) on delete cascade,
  graph_message_id text not null,
  graph_attachment_id text not null,
  owner_email text not null,
  name text,
  content_type text,
  size_bytes integer,
  is_inline boolean not null default false,
  content_text text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (graph_message_id, graph_attachment_id)
);

create index if not exists email_attachments_message_id_idx
  on public.email_attachments (message_id);

create index if not exists email_attachments_owner_name_idx
  on public.email_attachments (owner_email, name);

create index if not exists email_attachments_content_text_trgm_idx
  on public.email_attachments using gin (content_text gin_trgm_ops);

alter table public.email_attachments enable row level security;
