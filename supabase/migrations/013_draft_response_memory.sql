create extension if not exists pgcrypto;

create table if not exists public.draft_response_candidates (
  id uuid primary key default gen_random_uuid(),
  owner_email text not null,
  status text not null default 'candidate',
  graph_message_id text not null,
  graph_conversation_id text,
  message_id uuid references public.email_messages(id) on delete cascade,
  sender_email text not null,
  sender_name text,
  subject text,
  received_at timestamptz,
  known_contact_score integer not null default 0,
  inbound_count integer not null default 0,
  outbound_count integer not null default 0,
  back_and_forth_thread_count integer not null default 0,
  reason text,
  context_summary text,
  draft_graph_message_id text,
  draft_body text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_email, graph_message_id)
);

create table if not exists public.draft_feedback (
  id uuid primary key default gen_random_uuid(),
  owner_email text not null,
  candidate_id uuid references public.draft_response_candidates(id) on delete set null,
  contact_entity_id uuid references public.entities(id) on delete set null,
  graph_message_id text,
  graph_conversation_id text,
  sender_email text,
  original_draft text,
  user_feedback text not null,
  revised_draft text,
  final_status text not null default 'noted',
  extracted_guidance text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists draft_response_candidates_owner_status_idx
  on public.draft_response_candidates (owner_email, status, received_at desc);

create index if not exists draft_response_candidates_sender_idx
  on public.draft_response_candidates (owner_email, sender_email, received_at desc);

create index if not exists draft_feedback_owner_sender_idx
  on public.draft_feedback (owner_email, sender_email, created_at desc);

alter table public.draft_response_candidates enable row level security;
alter table public.draft_feedback enable row level security;

revoke all on table public.draft_response_candidates from anon, authenticated;
revoke all on table public.draft_feedback from anon, authenticated;
grant all on table public.draft_response_candidates to service_role;
grant all on table public.draft_feedback to service_role;
