// The digest's running to-do list.
//
// Every Action Required item is saved as a digest_items row with
// classification = 'action_required'. Until it is closed (done, handed off,
// answered, or too old) it is shown again under "📌 Still open" on each
// morning's digest, with buttons to close it -- so nothing drops off just
// because a new day's digest was posted.

import { pacificParts } from './schedule.js';

export const OPEN_STATUSES = ['open', 'snoozed'];
export const MAX_CARRY_OVER = 12;
export const EXPIRE_AFTER_DAYS = 14;

// Who the "Hand off" menu can forward an item to. Set in Vercel as JSON, e.g.
// HANDOFF_CONTACTS=[{"key":"conor","name":"Conor","email":"conor@..."},...]
// With nothing set, the hand-off menu is simply not shown.
export function handoffContacts(env = process.env) {
  try {
    const parsed = JSON.parse(env.HANDOFF_CONTACTS || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((c) => c && c.key && c.name && /@/.test(c.email || ''))
      : [];
  } catch {
    console.error('HANDOFF_CONTACTS is not valid JSON; hand-off menu disabled');
    return [];
  }
}

// YYYY-MM-DD for the day after `now`, in Seattle.
export function tomorrowPacific(now = new Date()) {
  return pacificParts(new Date(now.getTime() + 24 * 60 * 60 * 1000)).date;
}

function lineFor(digestText, itemNumber) {
  return (digestText || '').split('\n').find((l) => l.includes(`[#${itemNumber}]`)) || null;
}

// Short human label for an item, e.g. "Marla Branch — Vintage Tacoma supplemental app".
export function itemLabel(item) {
  const who = item.sender_name || item.sender_email || 'Unknown sender';
  const what = item.subject ? ` — ${item.subject}` : '';
  const label = `${who}${what}`;
  return label.length > 110 ? `${label.slice(0, 107)}…` : label;
}

// "since Mon" style age for a carried-over item.
export function sinceLabel(createdAt, now = new Date()) {
  const created = pacificParts(new Date(createdAt));
  const today = pacificParts(now);
  const days = Math.round((Date.parse(today.date) - Date.parse(created.date)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'since yesterday';
  if (days < 7) return `since ${created.weekday}`;
  return `${days} days`;
}

// Mark today's verified Action Required rows as to-dos, and close any older
// open to-do for the same email thread (today's row replaces it, so the same
// thread never shows twice).
export async function markActionItems(supabase, savedItems, actionNumbers, digestText) {
  const byNumber = new Map((savedItems || []).map((i) => [i.item_number, i]));
  const marked = [];
  for (const n of actionNumbers || []) {
    const item = byNumber.get(n);
    if (!item?.id) continue;
    const action_line = lineFor(digestText, n);
    const { error } = await supabase
      .from('digest_items')
      .update({ classification: 'action_required', action_line, updated_at: new Date().toISOString() })
      .eq('id', item.id);
    if (error) {
      console.error('markActionItems: update failed', { id: item.id, error });
      continue;
    }
    marked.push({ ...item, classification: 'action_required', action_status: 'open', action_line });
  }

  const conversations = marked.map((i) => i.graph_conversation_id).filter(Boolean);
  const ids = marked.map((i) => i.id);
  if (conversations.length > 0) {
    const { error } = await supabase
      .from('digest_items')
      .update({ action_status: 'carried', resolved_at: new Date().toISOString() })
      .eq('classification', 'action_required')
      .in('action_status', OPEN_STATUSES)
      .in('graph_conversation_id', conversations)
      .not('id', 'in', `(${ids.join(',')})`);
    if (error) console.error('markActionItems: closing superseded items failed', { error });
  }
  return marked;
}

// Open to-dos from earlier digests that should show today: still open, not
// snoozed past today, one per email thread (newest wins).
export async function loadCarryOver(supabase, currentRunId, now = new Date()) {
  const today = pacificParts(now).date;
  let query = supabase
    .from('digest_items')
    .select('id, digest_run_id, item_number, graph_message_id, graph_conversation_id, sender_name, sender_email, subject, received_at, action_status, snoozed_until, action_line, created_at, auto_draft_id, auto_draft_body, auto_draft_modified_at')
    .eq('classification', 'action_required')
    .in('action_status', OPEN_STATUSES)
    .order('created_at', { ascending: false })
    .limit(60);
  if (currentRunId) query = query.neq('digest_run_id', currentRunId);
  const { data, error } = await query;
  if (error) {
    console.error('loadCarryOver failed', { error });
    return [];
  }
  const seen = new Set();
  const due = [];
  for (const item of data || []) {
    if (item.snoozed_until && item.snoozed_until > today) continue;
    const key = item.graph_conversation_id || item.id;
    if (seen.has(key)) continue;
    seen.add(key);
    due.push(item);
  }
  return due.reverse(); // oldest first
}

async function closeItems(supabase, ids, status) {
  if (ids.length === 0) return;
  const { error } = await supabase
    .from('digest_items')
    .update({ action_status: status, resolved_at: new Date().toISOString() })
    .in('id', ids);
  if (error) console.error(`closeItems(${status}) failed`, { error });
}

// Closes carried-over items Grant has already answered (a message in his Sent
// Items on the same thread, sent after the item arrived) and items older than
// EXPIRE_AFTER_DAYS. Returns what is still open plus what was closed.
export async function sweepCarryOver({ supabase, graph, token, ownerEmail, items, now = new Date() }) {
  const replied = [];
  const expired = [];
  const stillOpen = [];
  for (const item of items) {
    const ageDays = (now.getTime() - Date.parse(item.created_at)) / 86400000;
    if (ageDays > EXPIRE_AFTER_DAYS) {
      expired.push(item);
      continue;
    }
    if (item.graph_conversation_id && token) {
      try {
        const conv = item.graph_conversation_id.replace(/'/g, "''");
        const res = await graph(
          token,
          `/users/${ownerEmail}/mailFolders/sentitems/messages?$filter=${encodeURIComponent(`conversationId eq '${conv}'`)}&$select=sentDateTime&$top=10`
        );
        const since = Date.parse(item.received_at || item.created_at);
        if ((res?.value || []).some((m) => Date.parse(m.sentDateTime) > since)) {
          replied.push(item);
          continue;
        }
      } catch (err) {
        // A failed check leaves the item open; never close on a guess.
        console.error('sweepCarryOver: sent-items check failed', { id: item.id, error: err.message });
      }
    }
    stillOpen.push(item);
  }
  await closeItems(supabase, replied.map((i) => i.id), 'replied');
  await closeItems(supabase, expired.map((i) => i.id), 'expired');
  return { stillOpen: stillOpen.slice(0, MAX_CARRY_OVER), replied, expired, overflow: Math.max(0, stillOpen.length - MAX_CARRY_OVER) };
}

// The "📌 Still open" section and footer lines appended to the digest text.
export function formatCarryOverSection({ stillOpen, replied, expired, overflow }, now = new Date()) {
  const lines = [];
  if (stillOpen.length > 0) {
    lines.push('', '*📌 Still open from earlier*');
    for (const item of stillOpen) {
      lines.push(`- ${itemLabel(item)} _(${sinceLabel(item.created_at, now)})_`);
    }
    if (overflow > 0) lines.push(`_…and ${overflow} more older item${overflow > 1 ? 's' : ''}_`);
  }
  const closed = [];
  if (replied.length > 0) closed.push(`${replied.length} closed because you replied`);
  if (expired.length > 0) closed.push(`${expired.length} dropped after ${EXPIRE_AFTER_DAYS} days`);
  if (closed.length > 0) lines.push(`_✅ To-do list: ${closed.join(', ')}_`);
  return lines.join('\n');
}
