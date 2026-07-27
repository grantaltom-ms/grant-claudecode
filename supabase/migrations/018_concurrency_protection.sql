-- 018_concurrency_protection.sql
--
-- Phase 6.2 of the reliability runbook: concurrency/duplicate protection.
--
-- 1. thread_state.version: optimistic-concurrency column for the Comply bot.
--    saveState() now writes `WHERE version = :expected` and reloads-and-
--    retries once on a version mismatch, instead of blindly overwriting
--    whatever's there -- two button clicks close together could otherwise
--    silently clobber each other's section approvals.
--
-- 2. processed_slack_events: Slack retries an event delivery if it doesn't
--    get a fast-enough 200 (or on any transient error), so the same event_id
--    can arrive twice. Both Slack event handlers (inbox-assistant.js,
--    comply-vacate.js) now claim the event_id here before doing any work;
--    a conflict means it's already been (or is already being) processed.
--    Locked down the same way as every other table in this project (RLS +
--    service_role-only grants) from the start, rather than needing a later
--    security-lockdown migration for it.

begin;

alter table public.thread_state add column if not exists version integer not null default 0;

create table if not exists public.processed_slack_events (
  event_id text primary key,
  processed_at timestamptz not null default now()
);

alter table public.processed_slack_events enable row level security;
revoke all on table public.processed_slack_events from anon, authenticated;
grant all on table public.processed_slack_events to service_role;

commit;
