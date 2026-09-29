// Auto-drafted replies for the digest's Action Required items.
//
// For each item the bot writes a reply in Grant's voice and saves it as a real
// Outlook reply draft (threaded, CCs kept). Nothing is ever sent from here --
// sending still goes through send_draft, which needs Grant's explicit OK.
//
// Voice comes from three places: Grant's own earlier messages in the same
// thread, a sample of his recent sent mail, and the corrections he has given
// on past drafts (draft_feedback). Facts the bot can't know (amounts, dates,
// decisions) are left as [bracketed] blanks rather than guessed.

import { responseText } from './claude.js';

export const MAX_AUTO_DRAFTS = 8;
export const DRAFT_CONCURRENCY = 3;
export const CLEANUP_AFTER_DAYS = 3;

function stripHtml(html = '') {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Cut quoted history ("On ... wrote:", "From: ...") so samples show what
// Grant actually wrote, not the thread below it.
export function ownText(body = '') {
  const text = stripHtml(body);
  const cut = text.search(/\n(On .+wrote:|From: .+|-----Original Message-----|________________________________)/);
  return (cut > 0 ? text.slice(0, cut) : text).trim().slice(0, 900);
}

export function htmlFromPlain(text) {
  return text
    .split('\n')
    .map((line) => `<div>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') || '&nbsp;'}</div>`)
    .join('');
}

export async function loadStyleContext({ supabase, graph, token, ownerEmail }) {
  const [sent, feedback] = await Promise.all([
    graph(token, `/users/${ownerEmail}/mailFolders/sentitems/messages?$top=12&$select=subject,body,toRecipients&$orderby=sentDateTime desc`)
      .then((r) => (r?.value || []).map((m) => ownText(m.body?.content)).filter((t) => t.length > 20).slice(0, 8))
      .catch((err) => {
        console.error('auto-drafts: sent-mail samples failed', err.message);
        return [];
      }),
    supabase
      .from('draft_feedback')
      .select('user_feedback, extracted_guidance')
      .eq('owner_email', ownerEmail)
      .order('created_at', { ascending: false })
      .limit(12)
      .then(({ data }) => (data || []).map((f) => f.extracted_guidance || f.user_feedback).filter(Boolean)),
  ]);
  return { sentSamples: sent, feedback };
}

function buildPrompt({ original, thread, style }) {
  const from = original.from?.emailAddress || {};
  const threadText = thread
    .map((m) => `${m.fromGrant ? 'GRANT' : (m.from || 'THEM')}: ${m.text}`)
    .join('\n---\n');
  return {
    system: `You draft email replies for Grant Carlson, Head of Operations at Milestone Properties (Seattle apartment owner/manager). The draft is saved for Grant to review; it is never sent without him.

Write exactly as Grant writes. Match his length, greeting, sign-off, and tone from his real emails below. Be direct and practical; no filler.

Never invent facts. Any amount, date, decision, name, or commitment you do not have from the thread goes in [square brackets] as a blank for Grant to fill, e.g. "[approve / decline]", "[amount]". Do not promise things Grant hasn't agreed to.

Return ONLY JSON: {"needs_reply": true|false, "body": "plain-text reply body", "blanks": ["each [bracketed] item"]}. Set needs_reply false only if replying would be odd (e.g. an automated notice).`,
    user: `GRANT'S RECENT SENT EMAILS (for voice only):
${style.sentSamples.map((s, i) => `(${i + 1}) ${s}`).join('\n\n') || '(none available)'}

GRANT'S PAST CORRECTIONS TO DRAFTS (follow these):
${style.feedback.map((f) => `- ${f}`).join('\n') || '(none yet)'}

EARLIER MESSAGES IN THIS THREAD (oldest first):
${threadText || '(none)'}

EMAIL TO REPLY TO
From: ${from.name || ''} <${from.address || ''}>
Subject: ${original.subject || ''}

${ownText(original.body?.content) || original.bodyPreview || ''}`,
  };
}

function parseDraftJson(text) {
  const match = (text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return typeof parsed.body === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

// Saves `body` as a threaded reply draft to `messageId`, keeping CCs.
export async function saveReplyDraft({ graph, token, ownerEmail, messageId, ccRecipients = [], body }) {
  const draft = await graph(token, `/users/${ownerEmail}/messages/${messageId}/createReply`, 'POST', {
    comment: htmlFromPlain(body),
    ...(ccRecipients.length && { message: { ccRecipients } }),
  });
  return { id: draft.id, lastModified: draft.lastModifiedDateTime || null };
}

async function draftOne({ item, supabase, graph, token, ownerEmail, callClaude, style, now }) {
  const base = `/users/${ownerEmail}`;
  const original = await graph(token, `${base}/messages/${item.graph_message_id}?$select=subject,from,ccRecipients,body,bodyPreview,conversationId`);
  let thread = [];
  if (original.conversationId) {
    const conv = original.conversationId.replace(/'/g, "''");
    const res = await graph(token, `${base}/messages?$filter=${encodeURIComponent(`conversationId eq '${conv}'`)}&$select=from,body,receivedDateTime&$top=8`).catch(() => ({ value: [] }));
    thread = (res?.value || [])
      .filter((m) => m.id !== item.graph_message_id)
      .sort((a, b) => Date.parse(a.receivedDateTime) - Date.parse(b.receivedDateTime))
      .map((m) => ({
        fromGrant: (m.from?.emailAddress?.address || '').toLowerCase() === ownerEmail.toLowerCase(),
        from: m.from?.emailAddress?.name,
        text: ownText(m.body?.content).slice(0, 600),
      }));
  }

  const prompt = buildPrompt({ original, thread, style });
  const response = await callClaude({ system: prompt.system, messages: [{ role: 'user', content: prompt.user }], maxTokens: 1500 });
  const parsed = parseDraftJson(responseText(response));
  if (!parsed || parsed.needs_reply === false || !parsed.body.trim()) return null;

  const body = parsed.body.trim();
  const saved = await saveReplyDraft({ graph, token, ownerEmail, messageId: item.graph_message_id, ccRecipients: original.ccRecipients || [], body });
  const { error } = await supabase
    .from('digest_items')
    .update({
      auto_draft_id: saved.id,
      auto_draft_body: body,
      auto_draft_created_at: now.toISOString(),
      auto_draft_modified_at: saved.lastModified,
    })
    .eq('id', item.id);
  if (error) console.error('auto-drafts: could not link draft to item', { id: item.id, error });
  return { ...item, auto_draft_id: saved.id, auto_draft_body: body, auto_draft_modified_at: saved.lastModified };
}

// Drafts replies for today's Action Required items. Never throws: a failure
// on one item just means that item has no draft (logged).
export async function writeAutoDrafts({ supabase, graph, token, ownerEmail, callClaude, items, now = new Date() }) {
  const todo = (items || []).filter((i) => i.id && i.graph_message_id && !i.auto_draft_id).slice(0, MAX_AUTO_DRAFTS);
  if (todo.length === 0) return [];
  const style = await loadStyleContext({ supabase, graph, token, ownerEmail });
  const results = [];
  for (let i = 0; i < todo.length; i += DRAFT_CONCURRENCY) {
    const batch = await Promise.all(
      todo.slice(i, i + DRAFT_CONCURRENCY).map((item) =>
        draftOne({ item, supabase, graph, token, ownerEmail, callClaude, style, now }).catch((err) => {
          console.error('auto-drafts: draft failed', { id: item.id, error: err.message });
          return null;
        })
      )
    );
    results.push(...batch.filter(Boolean));
  }
  return results;
}

async function clearDraftLink(supabase, itemId) {
  await supabase
    .from('digest_items')
    .update({ auto_draft_id: null, auto_draft_body: null, auto_draft_modified_at: null })
    .eq('id', itemId);
}

// Deletes the bot's draft for an item -- but only if Grant never edited it
// (unless `force`, used by the explicit 🗑 Delete draft button). A draft that
// is already gone (sent or deleted in Outlook) just gets unlinked.
// Returns 'deleted' | 'kept_edited' | 'gone' | 'none'.
export async function removeAutoDraft({ supabase, graph, token, ownerEmail, item, force = false }) {
  if (!item?.auto_draft_id) return 'none';
  const path = `/users/${ownerEmail}/messages/${item.auto_draft_id}`;
  let current;
  try {
    current = await graph(token, `${path}?$select=isDraft,lastModifiedDateTime`);
  } catch (err) {
    if (/404|ErrorItemNotFound|not found/i.test(err.message)) {
      await clearDraftLink(supabase, item.id);
      return 'gone';
    }
    throw err;
  }
  if (!current?.isDraft) {
    await clearDraftLink(supabase, item.id);
    return 'gone';
  }
  const edited = item.auto_draft_modified_at && current.lastModifiedDateTime !== item.auto_draft_modified_at;
  if (edited && !force) return 'kept_edited';
  await graph(token, path, 'DELETE');
  await clearDraftLink(supabase, item.id);
  return 'deleted';
}

// Morning cleanup: bot drafts older than CLEANUP_AFTER_DAYS that Grant never
// touched are deleted; edited ones are left alone.
export async function cleanupStaleDrafts({ supabase, graph, token, ownerEmail, now = new Date() }) {
  const cutoff = new Date(now.getTime() - CLEANUP_AFTER_DAYS * 86400000).toISOString();
  const { data, error } = await supabase
    .from('digest_items')
    .select('id, auto_draft_id, auto_draft_modified_at, auto_draft_created_at')
    .not('auto_draft_id', 'is', null)
    .lt('auto_draft_created_at', cutoff)
    .limit(40);
  if (error) {
    console.error('cleanupStaleDrafts: query failed', { error });
    return { deleted: 0, kept: 0 };
  }
  let deleted = 0;
  let kept = 0;
  for (const item of data || []) {
    try {
      const result = await removeAutoDraft({ supabase, graph, token, ownerEmail, item });
      if (result === 'deleted') deleted += 1;
      if (result === 'kept_edited') kept += 1;
    } catch (err) {
      console.error('cleanupStaleDrafts: failed on item', { id: item.id, error: err.message });
    }
  }
  return { deleted, kept };
}

// Replaces an item's draft with a revised body: writes the new draft first,
// then deletes the old one, so a failure never leaves Grant with no draft.
export async function reviseAutoDraft({ supabase, graph, token, ownerEmail, item, body, now = new Date() }) {
  const original = await graph(token, `/users/${ownerEmail}/messages/${item.graph_message_id}?$select=ccRecipients`);
  const saved = await saveReplyDraft({ graph, token, ownerEmail, messageId: item.graph_message_id, ccRecipients: original.ccRecipients || [], body });
  if (item.auto_draft_id) {
    await graph(token, `/users/${ownerEmail}/messages/${item.auto_draft_id}`, 'DELETE').catch((err) =>
      console.error('reviseAutoDraft: old draft delete failed', err.message)
    );
  }
  await supabase
    .from('digest_items')
    .update({ auto_draft_id: saved.id, auto_draft_body: body, auto_draft_created_at: now.toISOString(), auto_draft_modified_at: saved.lastModified })
    .eq('id', item.id);
  return { draft_id: saved.id };
}
