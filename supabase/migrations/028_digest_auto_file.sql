-- Auto-filing clear noise out of the inbox into "Filed by Bot".
--
-- filed_message_id: Graph gives a moved message a NEW id, so the id in the
-- "Filed by Bot" folder is kept here for the one-tap "put back".
-- auto_file_exceptions: senders Grant has put back; they are never filed again.

alter table public.digest_items
  add column if not exists filed_message_id text,
  add column if not exists filed_at timestamptz;

create table if not exists public.auto_file_exceptions (
  id uuid primary key default gen_random_uuid(),
  owner_email text not null,
  sender_email text not null,
  created_at timestamptz not null default now(),
  unique (owner_email, sender_email)
);

alter table public.auto_file_exceptions enable row level security;
revoke all on table public.auto_file_exceptions from anon, authenticated;
grant all on table public.auto_file_exceptions to service_role;
