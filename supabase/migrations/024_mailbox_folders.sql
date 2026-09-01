create table if not exists public.mailbox_folders (
  id uuid primary key default gen_random_uuid(),
  owner_email text not null,
  folder_key text not null,
  display_name text not null,
  graph_folder_id text not null,
  created_at timestamptz not null default now(),
  unique (owner_email, folder_key)
);

alter table public.mailbox_folders enable row level security;

revoke all on table public.mailbox_folders from anon, authenticated;
grant all on table public.mailbox_folders to service_role;
