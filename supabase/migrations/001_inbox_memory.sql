create extension if not exists pgcrypto;

create table if not exists public.email_messages (
  id uuid primary key default gen_random_uuid(),
  graph_message_id text not null unique,
  graph_conversation_id text,
  internet_message_id text,
  owner_email text not null,
  folder text not null,
  subject text,
  sender_name text,
  sender_email text,
  recipients jsonb not null default '[]'::jsonb,
  cc_recipients jsonb not null default '[]'::jsonb,
  received_at timestamptz,
  sent_at timestamptz,
  importance text,
  is_read boolean,
  has_attachments boolean not null default false,
  body_preview text,
  raw_graph_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists email_messages_owner_received_idx
  on public.email_messages (owner_email, received_at desc);

create index if not exists email_messages_conversation_idx
  on public.email_messages (graph_conversation_id);

create index if not exists email_messages_sender_email_idx
  on public.email_messages (sender_email);

alter table public.email_messages enable row level security;
