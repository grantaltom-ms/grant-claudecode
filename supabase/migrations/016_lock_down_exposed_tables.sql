-- 016_lock_down_exposed_tables.sql
--
-- Incident fix: the anon key for this Supabase project (augbrysfqwgekfhfokco)
-- was committed in plaintext to a PUBLIC GitHub repo (underwriting/src/lib/supabase.js,
-- present since the repo's first commit) and dozens of tables had no real access
-- control behind that key. Confirmed directly: an unauthenticated request using
-- only the anon key could read all of tenant_directory, owners, and
-- income_statement_lines.
--
-- This migration locks down every table where a full read/write lockdown to
-- service_role-only is unambiguous -- no code in this repo, and no comment on
-- the table itself, indicates any legitimate anon/authenticated use.
--
-- Deliberately NOT included here (see Phase 2 of the master runbook for why):
--   delinquency_cases, delinquency_outreach_log   -- Zapier automation uses anon key
--   properties                                    -- possible public listings use, unconfirmed
--   saved_deals                                   -- underwriting app writes via anon key, no auth
--   turns, turn_tasks, turn_events                -- unknown app, real data present (751+ rows)
--   onboarding_users, onboarding_acknowledgments,
--   onboarding_chat_history, onboarding_completions,
--   app_users, profiles                           -- policy names ("read_own") imply a real
--                                                   -- per-user app; qual is `true` (a bug, not by
--                                                   -- design) but blindly locking could break a
--                                                   -- live onboarding flow rather than just fixing it
--   web_chat_sessions, web_chat_messages           -- table comments confirm this is live leasing
--                                                   -- infrastructure (SMS/email/Zillow prospect
--                                                   -- chat) that needs some anon access by design
--
-- Backend code in this repo (pages/api/*, lib/*) uses SUPABASE_SERVICE_ROLE_KEY,
-- which bypasses RLS entirely -- nothing in this migration affects that code path.

begin;

-- ============================================================================
-- Group 1: RLS was disabled entirely (27 tables). Enable RLS as defense in
-- depth, then revoke anon/authenticated grants and confirm service_role access.
-- ============================================================================

do $$
declare
  t text;
  tables text[] := array[
    'agent_context',
    'amazon_line_items',
    'balance_sheet_lines',
    'bot_config',
    'bot_log',
    'bot_settings',
    'delinquency_inbound_log',
    'delinquency_snapshots',
    'expense_allocations',
    'expense_batches',
    'expense_transactions',
    'gl_import_staging',
    'income_statement_lines',
    'income_statement_summary',
    'is_import_staging',
    'manager_inquiries',
    'market_events',
    'owner_properties',
    'owners',
    'portfolio_snapshots',
    'property_group_members',
    'purchasers',
    'receivables_activity',
    'thread_state',
    'unit_vacancy_snapshots',
    'work_order_status_history',
    'work_orders'
  ];
begin
  foreach t in array tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end $$;

-- ============================================================================
-- Group 2: RLS was already enabled, but the active policy grants access to
-- everyone regardless (either role `public` with `USING (true)`, or roles
-- `{anon,authenticated}` with `USING (true)`). Two of these -- tenant_directory
-- and property_managers -- have a policy literally named "Service role full
-- access" that was actually written to apply to role `public` (everyone),
-- not `service_role`. Drop the misleading/permissive policies, then revoke
-- and re-grant the same way as Group 1.
-- ============================================================================

drop policy if exists "Service role full access" on public.tenant_directory;
drop policy if exists "Service role full access" on public.property_managers;
drop policy if exists "team_members read" on public.team_members;
drop policy if exists "team_members write" on public.team_members;
drop policy if exists "property_aliases_open" on public.property_aliases;
drop policy if exists "task_notes_open" on public.task_notes;
drop policy if exists "admin_stage_config_open" on public.admin_stage_config;
drop policy if exists "stage_default_tasks_open" on public.stage_default_tasks;
drop policy if exists "stage_task_template_items_open" on public.stage_task_template_items;
drop policy if exists "stage_task_templates_open" on public.stage_task_templates;

do $$
declare
  t text;
  tables text[] := array[
    'tenant_directory',
    'property_managers',
    'team_members',
    'property_aliases',
    'task_notes',
    'admin_stage_config',
    'stage_default_tasks',
    'stage_task_template_items',
    'stage_task_templates'
  ];
begin
  foreach t in array tables loop
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end $$;

-- ============================================================================
-- Group 3: reporting views and materialized views. SECURITY DEFINER views run
-- with the privileges of whoever created them, which can bypass RLS on the
-- underlying tables entirely if the view itself is grantable to anon/
-- authenticated -- so Group 1/2's table-level fixes alone don't close this off.
-- Materialized views don't support RLS the same way tables do, so the same
-- grant-revocation is the correct fix for those too.
-- ============================================================================

do $$
declare
  v text;
  views text[] := array[
    'unit_vacancy_with_manager',
    'v_open_options_positions',
    'v_options_performance',
    'v_pnl_attribution',
    'v_portfolio_risk',
    'vacancy_by_manager',
    'vacancy_by_property',
    'mv_annual_property_summary',
    'mv_monthly_expenses_by_category',
    'mv_portfolio_annual'
  ];
begin
  foreach v in array views loop
    execute format('revoke all on public.%I from anon, authenticated', v);
    execute format('grant all on public.%I to service_role', v);
  end loop;
end $$;

commit;

-- After running: re-check with the Supabase security advisor (or
-- `select * from pg_policies where schemaname = 'public'` /
-- `select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace`)
-- to confirm every table above now shows rls_enabled = true and no anon/
-- authenticated grants remain.
