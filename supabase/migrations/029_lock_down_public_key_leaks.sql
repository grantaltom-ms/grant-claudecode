-- 029_lock_down_public_key_leaks.sql
--
-- The public (anon) key for this project ships in browser apps and is visible in
-- this public repo, so anything it can read is effectively public. Checked
-- 2026-11-02 by acting as `anon` and counting rows. The sensitive financial and
-- tenant tables were already closed (016/017/020/021), but these were still open:
--
--   web_chat_sessions / web_chat_messages
--       Website leasing-chat leads: prospect names, phones, emails, budgets, tour
--       dates. Anyone could read AND edit them. Nothing needs the public key here:
--       milestone-chat's server (api/chat.ts) writes with the service-role key and
--       its website embed never talks to the database. Edge logs for the last 24h
--       show no anon traffic on either table.
--
--   onboarding_users / _completions / _acknowledgments / _chat_history / _modules
--       Staff names and emails, readable and writable by anyone. The onboarding app
--       (milestone-onboarding, a browser-only app with a pick-your-name "login")
--       used the public key for this; Grant confirmed on 2026-11-02 that it is
--       retired. That app stops working after this migration.
--
--   properties
--       Every column was public, including manager phone/email, owner entity and
--       internal notes. The public key now keeps listing columns only. Logged-in
--       apps (authenticated) and the service role are unchanged. No anon traffic
--       on properties in the last 24h of edge logs.
--
-- saved_deals is handled separately: the underwriting app needs a server route
-- before its public access can be removed.
--
-- Not touched: service_role (bypasses RLS) and the zag_agent / zag_readonly roles.

begin;

-- Website chat leads: server-only.
drop policy if exists "anon can insert messages" on public.web_chat_messages;
drop policy if exists "anon can select messages" on public.web_chat_messages;
drop policy if exists "anon can insert sessions" on public.web_chat_sessions;
drop policy if exists "anon can select sessions" on public.web_chat_sessions;
drop policy if exists "anon can update sessions" on public.web_chat_sessions;
revoke all on table public.web_chat_messages from anon, authenticated;
revoke all on table public.web_chat_sessions from anon, authenticated;

-- Retired onboarding app: server-only.
drop policy if exists "users_insert" on public.onboarding_users;
drop policy if exists "users_read_own" on public.onboarding_users;
drop policy if exists "completions_insert" on public.onboarding_completions;
drop policy if exists "completions_read" on public.onboarding_completions;
drop policy if exists "acks_insert" on public.onboarding_acknowledgments;
drop policy if exists "acks_read" on public.onboarding_acknowledgments;
drop policy if exists "chat_insert" on public.onboarding_chat_history;
drop policy if exists "chat_read" on public.onboarding_chat_history;
drop policy if exists "modules_public_read" on public.onboarding_modules;
revoke all on table public.onboarding_users, public.onboarding_completions, public.onboarding_acknowledgments,
                    public.onboarding_chat_history, public.onboarding_modules
  from anon, authenticated;

-- Properties: the public key may read listing columns only.
revoke select on table public.properties from anon;
grant select (id, name, address, city, state, zip, property_type, total_units, year_built,
              square_footage, neighborhood, status, is_group, is_active, managed_by_milestone)
  on table public.properties to anon;

-- Fail loudly if anything is still open.
do $$
declare t text;
begin
  foreach t in array array['web_chat_sessions','web_chat_messages','onboarding_users','onboarding_completions',
                           'onboarding_acknowledgments','onboarding_chat_history','onboarding_modules'] loop
    if has_table_privilege('anon', 'public.' || t, 'SELECT') or has_table_privilege('authenticated', 'public.' || t, 'SELECT') then
      raise exception '029 failed: % is still readable without the service key', t;
    end if;
  end loop;
  foreach t in array array['manager_phone','manager_email','manager_name','manager','owner_entity','notes','appfolio_id'] loop
    if has_column_privilege('anon', 'public.properties', t, 'SELECT') then
      raise exception '029 failed: anon can still read properties.%', t;
    end if;
  end loop;
  if not has_column_privilege('anon', 'public.properties', 'name', 'SELECT') then
    raise exception '029 failed: anon lost the property name';
  end if;
end $$;

commit;
