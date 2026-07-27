-- 017_lock_down_properties.sql
--
-- Phase 2c of the security/reliability runbook: `properties` was found with a
-- wide-open policy ("properties_open", roles {anon,authenticated}, cmd ALL,
-- qual/with_check `true`) — the same leaked-anon-key exposure as migration 016,
-- just not included there because it needed confirmation first.
--
-- Grant confirmed there is no public-facing site reading `properties` directly
-- (no listings page), so this locks down the same way as everything in 016.
--
-- Already applied directly to the live database and verified (anon/authenticated
-- grants confirmed empty via information_schema.role_table_grants). This commit
-- adds it to migration history for the record.

begin;

drop policy if exists "properties_open" on public.properties;
revoke all on table public.properties from anon, authenticated;
grant all on table public.properties to service_role;

commit;
