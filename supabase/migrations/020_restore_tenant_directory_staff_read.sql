-- 020_restore_tenant_directory_staff_read.sql
--
-- Third and last table cut off by 016_lock_down_exposed_tables.sql
-- (`permission denied for table tenant_directory`, 19:20 UTC 2026-07-27).
--
-- This one is NOT restored symmetrically with the six in 019. tenant_directory
-- holds 2,148 rows of tenant PII -- name, email, phone, unit, lease dates --
-- and per 016's own header it is the table whose unauthenticated anon-key read
-- was the CONFIRMED breach that motivated the lockdown:
--
--   "an unauthenticated request using only the anon key could read all of
--    tenant_directory, owners, and income_statement_lines"
--
-- Restoring anon read would therefore re-open the exact hole 016 was written to
-- close. anon is deliberately left revoked, permanently.
--
-- What is granted instead: SELECT to `authenticated`, further gated on the
-- caller having a row in public.profiles. At time of writing all 9 auth users
-- are staff accounts on milestone domains (rentmilestone.com,
-- milestoneproperties.com, milestone.local) and all 9 have profiles, so this is
-- provisioned-staff-only rather than "anyone holding a session". That is
-- strictly tighter than the pre-lockdown state (world-readable via a publicly
-- committed anon key) and tighter than the bare `using (true)` used for the
-- non-sensitive lookup tables in 019.
--
-- Writes stay service_role-only. lib/comply-agent.js reads this table with the
-- service key and was never affected by the lockdown -- it is not the caller
-- that was denied.
--
-- KNOWN GAP: the caller denied at 19:20 has not been identified. It was not the
-- comply agent (no thread_state activity in that window) and not the
-- milestone-turns app (no reference to this table anywhere in that repo). If it
-- turns out to be an app authenticating with the publishable anon key, this
-- migration will NOT unblock it -- by design. The correct fix there is to move
-- that app to a server-side service_role path or a real signed-in session, not
-- to re-expose 2,148 tenant records to the anon role. See the notes on PR #15.

do $$ begin
  if to_regclass('public.tenant_directory') is null then return; end if;

  grant select on public.tenant_directory to authenticated;

  drop policy if exists "tenant_directory staff read" on public.tenant_directory;
  create policy "tenant_directory staff read" on public.tenant_directory
    for select to authenticated
    using (exists (select 1 from public.profiles p where p.id = auth.uid()));
end $$;
