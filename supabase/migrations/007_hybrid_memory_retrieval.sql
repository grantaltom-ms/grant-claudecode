create extension if not exists vector;
create extension if not exists pg_trgm;

alter table public.memory_chunks
  add column if not exists source_table text,
  add column if not exists source_pk text,
  add column if not exists graph_message_id text,
  add column if not exists graph_conversation_id text,
  add column if not exists title text,
  add column if not exists embedding_model text,
  add column if not exists embedded_at timestamptz,
  add column if not exists search_vector tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(chunk_summary, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(chunk_text, '')), 'C')
  ) stored;

create table if not exists public.retrieval_logs (
  id uuid primary key default gen_random_uuid(),
  owner_email text not null,
  query text not null,
  tool_name text,
  result_count integer not null default 0,
  used_embedding boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists memory_chunks_owner_source_idx
  on public.memory_chunks (owner_email, source_type, source_pk);

create unique index if not exists memory_chunks_owner_source_unique_idx
  on public.memory_chunks (owner_email, source_type, source_pk);

create index if not exists memory_chunks_graph_message_idx
  on public.memory_chunks (graph_message_id);

create index if not exists memory_chunks_graph_conversation_idx
  on public.memory_chunks (graph_conversation_id);

create index if not exists memory_chunks_search_vector_idx
  on public.memory_chunks using gin (search_vector);

create index if not exists memory_chunks_title_trgm_idx
  on public.memory_chunks using gin (title gin_trgm_ops);

create index if not exists memory_chunks_text_trgm_idx
  on public.memory_chunks using gin (chunk_text gin_trgm_ops);

create index if not exists memory_chunks_embedding_cosine_idx
  on public.memory_chunks
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100)
  where embedding is not null;

create index if not exists retrieval_logs_owner_created_idx
  on public.retrieval_logs (owner_email, created_at desc);

alter table public.retrieval_logs enable row level security;

create or replace function public.search_memory_chunks(
  p_owner_email text,
  p_query text,
  p_query_embedding vector(1536) default null,
  p_match_count integer default 10
)
returns table (
  id uuid,
  source_type text,
  source_table text,
  source_pk text,
  graph_message_id text,
  graph_conversation_id text,
  title text,
  chunk_text text,
  chunk_summary text,
  metadata jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  keyword_score double precision,
  vector_score double precision,
  combined_score double precision
)
language sql
stable
as $$
  with params as (
    select
      websearch_to_tsquery('english', coalesce(nullif(trim(p_query), ''), ' ')) as query_ts,
      '%' || replace(replace(coalesce(p_query, ''), '%', '\%'), '_', '\_') || '%' as query_like,
      greatest(1, least(coalesce(p_match_count, 10), 50)) as match_count
  ),
  scored as (
    select
      mc.id,
      mc.source_type,
      mc.source_table,
      mc.source_pk,
      mc.graph_message_id,
      mc.graph_conversation_id,
      mc.title,
      mc.chunk_text,
      mc.chunk_summary,
      coalesce(mc.metadata, '{}'::jsonb) as metadata,
      mc.created_at,
      mc.updated_at,
      (
        case
          when mc.search_vector @@ params.query_ts then ts_rank_cd(mc.search_vector, params.query_ts)::double precision
          else 0::double precision
        end
        + case when mc.title ilike params.query_like then 0.35 else 0 end
        + case when mc.chunk_text ilike params.query_like then 0.20 else 0 end
      ) as keyword_score,
      case
        when p_query_embedding is not null and mc.embedding is not null
          then (1 - (mc.embedding <=> p_query_embedding))::double precision
        else null::double precision
      end as vector_score
    from public.memory_chunks mc
    cross join params
    where mc.owner_email = p_owner_email
      and (
        mc.search_vector @@ params.query_ts
        or mc.title ilike params.query_like
        or mc.chunk_text ilike params.query_like
        or (p_query_embedding is not null and mc.embedding is not null)
      )
  )
  select
    scored.id,
    scored.source_type,
    scored.source_table,
    scored.source_pk,
    scored.graph_message_id,
    scored.graph_conversation_id,
    scored.title,
    scored.chunk_text,
    scored.chunk_summary,
    scored.metadata,
    scored.created_at,
    scored.updated_at,
    scored.keyword_score,
    scored.vector_score,
    (
      scored.keyword_score
      + coalesce(scored.vector_score, 0) * case when p_query_embedding is not null then 0.65 else 0 end
      + greatest(0, 0.15 - extract(epoch from (now() - coalesce(scored.updated_at, scored.created_at))) / 31536000.0 * 0.03)
    ) as combined_score
  from scored, params
  order by combined_score desc, updated_at desc nulls last
  limit (select match_count from params);
$$;
