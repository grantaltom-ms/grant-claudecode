alter table public.memory_chunks
  drop constraint if exists memory_chunks_entity_id_fkey;

alter table public.memory_chunks
  add constraint memory_chunks_entity_id_fkey
  foreign key (entity_id) references public.entities(id) on delete set null;
