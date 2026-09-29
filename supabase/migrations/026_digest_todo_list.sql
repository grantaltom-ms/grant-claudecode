-- Running to-do list for the morning digest.
--
-- An Action Required item used to live for exactly one digest: nothing
-- tracked whether Grant handled it, so unhandled items silently fell off the
-- next morning. These columns let an item stay open across days until it is
-- marked done, snoozed, handed off, answered, or it expires.
--
-- classification = 'action_required' marks the rows that were Action Required
-- (the triage model decides that; see lib/todo.js markActionItems).
-- action_status gains the values: snoozed, handed_off, replied, carried,
-- expired (text column, no constraint, so no type change is needed).

alter table public.digest_items
  add column if not exists snoozed_until date,
  add column if not exists resolved_at timestamptz,
  add column if not exists handed_off_to text,
  add column if not exists action_line text;

create index if not exists digest_items_open_todo_idx
  on public.digest_items (created_at)
  where classification = 'action_required' and action_status in ('open', 'snoozed');
