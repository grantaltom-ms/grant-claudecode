create table if not exists public.send_log (
  id bigint generated always as identity primary key,
  owner_email text not null,
  recipient text not null,
  message_id text,
  sent_at timestamptz not null default now()
);

create index if not exists send_log_owner_sent_idx
  on public.send_log (owner_email, sent_at desc);

alter table public.send_log enable row level security;

revoke all on table public.send_log from anon, authenticated;
grant all on table public.send_log to service_role;
