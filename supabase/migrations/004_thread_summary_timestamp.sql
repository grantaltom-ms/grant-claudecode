alter table public.email_threads
  add column if not exists summary_updated_at timestamptz;
