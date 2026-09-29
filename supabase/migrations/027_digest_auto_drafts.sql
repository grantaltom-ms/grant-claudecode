-- Auto-drafted replies for the digest's Action Required items.
--
-- Each morning the digest writes a reply draft (in Outlook Drafts) for every
-- Action Required item. These columns link a to-do row to its draft so Slack
-- can offer "📝 Review draft" / "🗑 Delete draft", so Grant can refine it in
-- the thread, and so unused drafts can be cleaned up after 3 days.
--
-- auto_draft_modified_at stores Graph's lastModifiedDateTime from when the bot
-- last wrote the draft. Cleanup only deletes a draft whose lastModifiedDateTime
-- still matches -- i.e. one Grant never touched.

alter table public.digest_items
  add column if not exists auto_draft_id text,
  add column if not exists auto_draft_body text,
  add column if not exists auto_draft_created_at timestamptz,
  add column if not exists auto_draft_modified_at text;

create index if not exists digest_items_auto_draft_idx
  on public.digest_items (auto_draft_created_at)
  where auto_draft_id is not null;
