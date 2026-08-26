-- 021_revoke_exec_sql_from_anon.sql
--
-- Revoke public/anon EXECUTE on public.exec_sql(text).
--
-- WHY
-- ---
-- public.exec_sql(text) is SECURITY DEFINER and owned by `postgres`. It takes an
-- arbitrary SQL string and runs it with the definer's privileges, which means every
-- statement it executes bypasses RLS and every table-level grant.
--
-- Its ACL was `{=X/postgres, postgres=X/postgres, anon=X/postgres,
-- authenticated=X/postgres, service_role=X/postgres}`. The leading `=X` is a grant to
-- PUBLIC, so EXECUTE was reachable by *every* role — including `anon`, and therefore by
-- anyone holding the publishable anon key. That key is committed to a public repository.
--
-- This defeated the table lockdowns in 016/017/020. Verified against production before
-- this migration, using only the anon key over PostgREST:
--
--   direct anon SELECT on tenant_directory  -> permission denied   (020 holding)
--   anon -> exec_sql('select ... tenant_directory')      -> 2,148 rows
--   anon -> exec_sql('select ... owners')                ->    45 rows
--   anon -> exec_sql('select ... income_statement_lines')-> 12,356 rows
--
-- Those are the same three tables 016's header names as the confirmed breach. The
-- function is a complete bypass of that entire remediation.
--
-- The function's only guard is a prefix check (`LIKE 'select%' OR LIKE 'with%'`), which
-- gates statement *shape*, not authorization — any SELECT the definer can run, a caller
-- can run. Writes are most likely blocked as a side effect of the wrapper: the body
-- interpolates the caller's text into
-- `SELECT json_agg(row_to_json(t)) FROM (<query>) t`, and PostgreSQL only permits
-- data-modifying CTEs at the top level of a statement, not inside a subquery. That was
-- not tested destructively, so treat read-only as likely rather than proven, and do not
-- rely on it as a security property.
--
-- WHAT THIS DOES
-- --------------
-- Revokes from PUBLIC and from `anon`. Revoking `anon` alone would have been a no-op —
-- the PUBLIC grant is what actually conferred access.
--
-- `authenticated` and `service_role` keep EXECUTE, so existing callers holding a real
-- session or the service key are unaffected. Note this is a deliberate stopping point,
-- not an endorsement: `authenticated` retaining EXECUTE means any signed-in user can
-- still read every table in the database through this function. Today that population is
-- 9 accounts, all on milestone-controlled domains, which is why it is not urgent — but it
-- is only safe for as long as sign-up stays closed to the public. See "follow-up" below.
--
-- The function's comment says "Zapier often appends them", so a Zap is a likely caller.
-- If a Zap breaks after this, the fix is to move it onto the service key — not to
-- re-grant `anon`.
--
-- APPLIED STATE
-- -------------
-- The revokes below are already live in production — they were applied directly, and the
-- end state was verified via has_function_privilege (anon=false, authenticated=true,
-- service_role=true, postgres=true). They were NOT registered in
-- supabase_migrations.schema_migrations, so this version will not appear in
-- `list_migrations` alongside 016-020. Re-running this file is safe and idempotent:
-- REVOKE on an already-revoked privilege is a no-op, and the assertion block at the
-- bottom re-checks the end state.

revoke execute on function public.exec_sql(text) from public;
revoke execute on function public.exec_sql(text) from anon;

comment on function public.exec_sql(text) is
  'SECURITY DEFINER arbitrary-SQL executor; bypasses RLS. EXECUTE revoked from PUBLIC and anon in 021 after anon-key read access to tenant_directory, owners, and income_statement_lines was confirmed in production. Do not re-grant to anon or PUBLIC. Prefer replacing with purpose-specific SECURITY DEFINER functions.';

-- Assert the intended end state; fail loudly if it is wrong.
do $$
begin
  if has_function_privilege('anon', 'public.exec_sql(text)', 'EXECUTE') then
    raise exception '021 failed: anon can still execute public.exec_sql(text)';
  end if;

  if not has_function_privilege('service_role', 'public.exec_sql(text)', 'EXECUTE') then
    raise exception '021 failed: service_role lost EXECUTE on public.exec_sql(text)';
  end if;
end
$$;

-- FOLLOW-UP (not done here)
-- -------------------------
-- 1. Confirm which Zap (if any) calls this, and which key it uses.
-- 2. Consider revoking from `authenticated` as well, leaving service_role only. Blocked
--    on (1) and on confirming no signed-in surface depends on it.
-- 3. Better still, retire this function. An unrestricted SQL executor reachable over
--    PostgREST is a standing bypass of every grant and policy in the database; narrow
--    SECURITY DEFINER functions for the specific queries callers actually need remove the
--    bypass instead of narrowing who can use it.
-- 4. Rotate the anon key. It is committed to a public repo and, until this migration, it
--    was sufficient to read the entire database. Assume it is compromised.
