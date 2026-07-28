-- 019_restore_turns_app_grants.sql
--
-- Remediates over-reach in 016_lock_down_exposed_tables.sql.
--
-- 016 revoked anon/authenticated grants and dropped the `*_open` policies on a
-- set of tables it judged unused. Its header states the basis: "no code in this
-- repo ... indicates any legitimate anon/authenticated use." That audit was
-- scoped to this repository only. The database is shared with the
-- milestone-turns app, which reads several of those tables through the anon key
-- via @supabase/ssr (role `authenticated` once signed in). Those reads started
-- failing with `permission denied for table ...`.
--
-- 016 nearly caught this -- it excluded turns/turn_tasks/turn_events as
-- "unknown app, real data present" -- but that exclusion covered three of the
-- turns app's tables and missed the rest.
--
-- 017_lock_down_properties.sql caused the same failure on `properties`; that
-- one was restored out-of-band from the milestone-turns repo and is not
-- reproduced here. This migration covers the remaining six tables.
--
-- Access levels below are NOT the wide-open `*_open` policies that 016 was
-- right to remove. They reinstate exactly what the milestone-turns repo's own
-- migrations (0006, 0007, 0011, 0012, 0016) document as intended: authenticated
-- reads, admin-gated writes, and anon read only where a migration explicitly
-- called for it.
--
-- Every block is guarded on table existence. These tables belong to the turns
-- app and are not created by this repo's migrations, so an unguarded replay
-- against a fresh database would fail.

-- task_notes (turns 0006): authenticated read-all; writes scoped to the note's
-- author. addTaskNoteAction sets author_id from the session user, so the
-- auth.uid() = author_id predicate holds for legitimate inserts.
do $$ begin
  if to_regclass('public.task_notes') is null then return; end if;

  grant select, insert, update, delete on public.task_notes to authenticated;

  drop policy if exists "task_notes read" on public.task_notes;
  create policy "task_notes read" on public.task_notes
    for select to authenticated using (true);

  drop policy if exists "task_notes insert" on public.task_notes;
  create policy "task_notes insert" on public.task_notes
    for insert to authenticated with check (auth.uid() = author_id);

  drop policy if exists "task_notes self mutate" on public.task_notes;
  create policy "task_notes self mutate" on public.task_notes
    for all to authenticated
    using (auth.uid() = author_id)
    with check (auth.uid() = author_id);
end $$;

-- stage_default_tasks (turns 0007 read, 0011 admin write). Anon read is
-- deliberate: the New Turn stage preview renders before sign-in.
do $$ begin
  if to_regclass('public.stage_default_tasks') is null then return; end if;

  grant select on public.stage_default_tasks to anon;
  grant select, insert, update, delete on public.stage_default_tasks to authenticated;

  drop policy if exists "stage_default_tasks read" on public.stage_default_tasks;
  create policy "stage_default_tasks read" on public.stage_default_tasks
    for select to anon, authenticated using (true);

  drop policy if exists "stage_default_tasks admin write" on public.stage_default_tasks;
  create policy "stage_default_tasks admin write" on public.stage_default_tasks
    for all to authenticated
    using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
    with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));
end $$;

-- admin_stage_config (turns 0012).
do $$ begin
  if to_regclass('public.admin_stage_config') is null then return; end if;

  grant select on public.admin_stage_config to anon;
  grant select, insert, update, delete on public.admin_stage_config to authenticated;

  drop policy if exists "admin_stage_config read" on public.admin_stage_config;
  create policy "admin_stage_config read" on public.admin_stage_config
    for select to anon, authenticated using (true);

  drop policy if exists "admin_stage_config admin write" on public.admin_stage_config;
  create policy "admin_stage_config admin write" on public.admin_stage_config
    for all to authenticated
    using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
    with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));
end $$;

-- stage_task_templates + stage_task_template_items (turns 0016): authenticated
-- read (no anon); admin-gated write.
do $$ begin
  if to_regclass('public.stage_task_templates') is null then return; end if;

  grant select, insert, update, delete on public.stage_task_templates to authenticated;

  drop policy if exists "stage_task_templates read" on public.stage_task_templates;
  create policy "stage_task_templates read" on public.stage_task_templates
    for select to authenticated using (true);

  drop policy if exists "stage_task_templates admin write" on public.stage_task_templates;
  create policy "stage_task_templates admin write" on public.stage_task_templates
    for all to authenticated
    using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
    with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));
end $$;

do $$ begin
  if to_regclass('public.stage_task_template_items') is null then return; end if;

  grant select, insert, update, delete on public.stage_task_template_items to authenticated;

  drop policy if exists "stage_task_template_items read" on public.stage_task_template_items;
  create policy "stage_task_template_items read" on public.stage_task_template_items
    for select to authenticated using (true);

  drop policy if exists "stage_task_template_items admin write" on public.stage_task_template_items;
  create policy "stage_task_template_items admin write" on public.stage_task_template_items
    for all to authenticated
    using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
    with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));
end $$;

-- property_aliases: read-only lookup consumed by the turns app's
-- loadPropertyLookup(). No migration in that repo creates it, so there is no
-- prior policy to mirror; read-only for authenticated matches actual use.
-- Writes stay service_role-only.
do $$ begin
  if to_regclass('public.property_aliases') is null then return; end if;

  grant select on public.property_aliases to authenticated;

  drop policy if exists "property_aliases read" on public.property_aliases;
  create policy "property_aliases read" on public.property_aliases
    for select to authenticated using (true);
end $$;
