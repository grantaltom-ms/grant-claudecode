create table if not exists public.context_cards (
  id uuid primary key default gen_random_uuid(),
  owner_email text not null,
  card_type text not null,
  card_key text not null,
  title text not null,
  summary text not null,
  facts jsonb not null default '{}'::jsonb,
  source_refs jsonb not null default '[]'::jsonb,
  related_entity_id uuid references public.entities(id) on delete set null,
  status text not null default 'active',
  importance text not null default 'normal',
  last_seen_at timestamptz not null default now(),
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search_vector tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(summary, '')), 'B')
  ) stored,
  unique (owner_email, card_type, card_key)
);

create index if not exists context_cards_owner_type_status_idx
  on public.context_cards (owner_email, card_type, status, updated_at desc);

create index if not exists context_cards_owner_seen_idx
  on public.context_cards (owner_email, last_seen_at desc);

create index if not exists context_cards_search_vector_idx
  on public.context_cards using gin (search_vector);

alter table public.context_cards enable row level security;

revoke all on table public.context_cards from anon, authenticated;
grant all on table public.context_cards to service_role;
