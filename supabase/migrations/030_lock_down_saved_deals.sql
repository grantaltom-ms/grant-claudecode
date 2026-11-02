-- 030_lock_down_saved_deals.sql
--
-- Follow-up to 029. saved_deals (underwriting deal analyses: prices, rents, NOI,
-- investment memos) had a policy "Allow all access to saved_deals" for every role,
-- so anyone holding the public (anon) key could read, edit or delete every deal.
--
-- The underwriting app (grantaltom-ms/underwriting#4, merged 2026-11-02) now
-- saves, lists and deletes deals through its own server route (/api/deals), which
-- uses the service-role key. Grant confirmed a save + delete on production before
-- this ran. Applied to augbrysfqwgekfhfokco on 2026-11-02 after a rolled-back
-- rehearsal; checked afterwards from outside: the public key gets
-- "permission denied" and the live /api/deals route still lists deals.
--
-- Note: the old copy of the app in underwriting/ in this repo still calls
-- saved_deals with the public key and will no longer work. It is not deployed;
-- the live app is the separate underwriting repo.
--
-- Not touched: service_role, and the zag_agent / zag_readonly roles, which keep
-- read access through their own policies (zag_read, zag_readonly_select).

drop policy if exists "Allow all access to saved_deals" on public.saved_deals;
revoke all on table public.saved_deals from anon, authenticated;

do $$
begin
  if has_table_privilege('anon', 'public.saved_deals', 'SELECT')
     or has_table_privilege('authenticated', 'public.saved_deals', 'SELECT') then
    raise exception '030 failed: saved_deals still readable without the service key';
  end if;
end $$;
