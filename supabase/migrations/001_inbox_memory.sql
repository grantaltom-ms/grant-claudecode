-- Inbox Assistant Memory Foundation
-- Purpose: persist Outlook inbox context so agents can retrieve relevant memory
-- instead of rereading the whole inbox.

create extension if not exists vector;

-- 1. Raw email messages from Microsoft Graph
create table if not exists email_messages (
  id uuid primary key default gen_random_uuid(),

  graph_message_id text not null unique,
  graph_conversation_id text,
  internet_message_id text,

  owner_email text not null,
  folder text default 'Inbox',

  subject text,
  sender_name text,
  sender_email text,
  recipients jsonb default '[]'::jsonb,
  cc_recipients jsonb default '[]'::jsonb,

  received_at timestamptz,
  sent_at timestamptz,

  importance text,
  is_read boolean,
  has_attachments boolean default false,

  body_preview text,
  body_text text,
  body_html text,

  raw_graph_payload jsonb,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_email_messages_owner_received
  on email_messages (owner_email, received_at desc);

create index if not exists idx_email_messages_conversation
  on email_messages (graph_conversation_id);

create index if not exists idx_email_messages_sender
  on email_messages (sender_email);


-- 2. Email threads / conversations
create table if not exists email_threads (
  id uuid primary key default gen_random_uuid(),

  graph_conversation_id text not null unique,
  owner_email text not null,

  subject_normalized text,
  participants jsonb default '[]'::jsonb,

  first_message_at timestamptz,
  last_message_at timestamptz,
  message_count integer default 0,

  current_summary text,
  current_status text default 'open',
  priority text default 'normal',

  needs_action boolean default false,
  action_summary text,
  next_action text,
  due_at timestamptz,

  last_summarized_at timestamptz,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_email_threads_owner_last_message
  on email_threads (owner_email, last_message_at desc);

create index if not exists idx_email_threads_needs_action
  on email_threads (owner_email, needs_action, last_message_at desc);


-- 3. Summaries over time, so thread memory can evolve
create table if not exists thread_summaries (
  id uuid primary key default gen_random_uuid(),

  thread_id uuid references email_threads(id) on delete cascade,
  summary_type text not null default 'current',

  summary text not null,
  open_items jsonb default '[]'::jsonb,
  decisions jsonb default '[]'::jsonb,
  commitments jsonb default '[]'::jsonb,
  risks jsonb default '[]'::jsonb,

  source_message_ids jsonb default '[]'::jsonb,

  created_at timestamptz default now()
);

create index if not exists idx_thread_summaries_thread
  on thread_summaries (thread_id, created_at desc);


-- 4. Durable entities: properties, vendors, tenants, staff, projects, etc.
create table if not exists memory_entities (
  id uuid primary key default gen_random_uuid(),

  entity_type text not null,
  name text not null,
  normalized_name text not null,

  description text,
  current_summary text,

  status text default 'active',
  metadata jsonb default '{}'::jsonb,

  first_seen_at timestamptz,
  last_seen_at timestamptz,

  created_at timestamptz default now(),
  updated_at timestamptz default now(),

  unique(entity_type, normalized_name)
);

create index if not exists idx_memory_entities_type_name
  on memory_entities (entity_type, normalized_name);


-- 5. Links between entities and emails/threads
create table if not exists entity_mentions (
  id uuid primary key default gen_random_uuid(),

  entity_id uuid references memory_entities(id) on delete cascade,
  message_id uuid references email_messages(id) on delete cascade,
  thread_id uuid references email_threads(id) on delete cascade,

  mention_text text,
  confidence numeric,
  extraction_source text default 'model',

  created_at timestamptz default now()
);

create index if not exists idx_entity_mentions_entity
  on entity_mentions (entity_id);

create index if not exists idx_entity_mentions_thread
  on entity_mentions (thread_id);


-- 6. Work items extracted from email
create table if not exists work_items (
  id uuid primary key default gen_random_uuid(),

  owner_email text not null,

  title text not null,
  description text,

  status text default 'open',
  priority text default 'normal',

  source_thread_id uuid references email_threads(id) on delete set null,
  source_message_id uuid references email_messages(id) on delete set null,
  related_entity_id uuid references memory_entities(id) on delete set null,

  assigned_to text,
  due_at timestamptz,
  completed_at timestamptz,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_work_items_owner_status
  on work_items (owner_email, status, priority, due_at);


-- 7. Digest runs posted to Slack
create table if not exists digest_runs (
  id uuid primary key default gen_random_uuid(),

  owner_email text not null,
  digest_type text default 'daily',
  lookback_start timestamptz,
  lookback_end timestamptz,

  slack_channel_id text,
  slack_thread_ts text,

  total_emails integer default 0,
  actionable_count integer default 0,
  archived_count integer default 0,

  digest_text text,

  created_at timestamptz default now()
);

create index if not exists idx_digest_runs_owner_created
  on digest_runs (owner_email, created_at desc);


-- 8. Stable mapping between Slack digest numbers and source emails
create table if not exists digest_items (
  id uuid primary key default gen_random_uuid(),

  digest_run_id uuid references digest_runs(id) on delete cascade,

  item_number integer,
  message_id uuid references email_messages(id) on delete set null,
  thread_id uuid references email_threads(id) on delete set null,

  classification text,
  summary text,
  suggested_action text,

  action_status text default 'pending',

  created_at timestamptz default now()
);

create index if not exists idx_digest_items_run_number
  on digest_items (digest_run_id, item_number);


-- 9. Retrieval chunks for hybrid/vector search
create table if not exists memory_chunks (
  id uuid primary key default gen_random_uuid(),

  owner_email text not null,

  source_type text not null,
  source_id uuid,

  entity_id uuid references memory_entities(id) on delete set null,
  thread_id uuid references email_threads(id) on delete set null,
  message_id uuid references email_messages(id) on delete set null,

  chunk_text text not null,
  chunk_summary text,
  metadata jsonb default '{}'::jsonb,

  embedding vector(1536),

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_memory_chunks_owner_source
  on memory_chunks (owner_email, source_type);

create index if not exists idx_memory_chunks_entity
  on memory_chunks (entity_id);

create index if not exists idx_memory_chunks_thread
  on memory_chunks (thread_id);
