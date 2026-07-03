create or replace function public.search_memory_chunks_api(
  p_owner_email text,
  p_query text,
  p_query_embedding_text text default null,
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
  select *
  from public.search_memory_chunks(
    p_owner_email,
    p_query,
    case
      when nullif(trim(p_query_embedding_text), '') is null then null::vector(1536)
      else p_query_embedding_text::vector(1536)
    end,
    p_match_count
  );
$$;

revoke execute on function public.search_memory_chunks_api(text, text, text, integer) from public, anon, authenticated;
grant execute on function public.search_memory_chunks_api(text, text, text, integer) to service_role;

notify pgrst, 'reload schema';
