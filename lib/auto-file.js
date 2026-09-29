// Moves clear noise (automated confirmations, newsletters, receipts, no-reply
// notifications) out of the inbox into an Outlook folder named "Filed by Bot".
// Nothing is deleted, the digest reports how many were filed, and every one
// can be put back with one tap -- which also stops that sender being filed
// again.
//
// The model only proposes candidates. Hard rules below have the final say and
// always err toward leaving mail in the inbox.

import { responseText } from './claude.js';
import { normalizeEmail } from './correspondent-history.js';

export const MAX_FILED_PER_DAY = 40;

// Subjects that suggest money or a deadline: never auto-filed, whatever the model says.
const NEEDS_ATTENTION = /\b(invoice|past due|overdue|payment (due|failed|declined|required)|balance due|action required|urgent|emergency|deadline|final notice|suspend|cancel(l)?ation|legal|court|motion|lawsuit|attorney|eviction|summons|subpoena|security alert|password|verify your|fraud|leak|flood|fire)\b/i;

function senderOf(email) {
  return normalizeEmail(email.from?.emailAddress?.address || '');
}

// Why an email must stay in the inbox, or null if it may be filed.
export function keepReason(email, { correspondentStats, exceptions, surfacedText, authFlaggedIds }) {
  const sender = senderOf(email);
  if (!sender) return 'no sender';
  if (exceptions.has(sender)) return 'sender was put back before';
  if (authFlaggedIds.has(email.id)) return 'failed sender check';
  if (email.importance === 'high') return 'marked important';
  if (NEEDS_ATTENTION.test(`${email.subject || ''} ${email.bodyPreview || ''}`)) return 'money, deadline, legal, or emergency';
  const stats = correspondentStats?.get(sender);
  if (stats && stats.outbound_count > 0) return 'someone Grant writes to';
  const name = (email.from?.emailAddress?.name || '').trim();
  const subjectBit = (email.subject || '').slice(0, 30).trim();
  if (surfacedText && ((name.length >= 4 && surfacedText.includes(name)) || (subjectBit.length >= 10 && surfacedText.includes(subjectBit)))) {
    return 'shown in the digest';
  }
  return null;
}

export async function loadExceptions(supabase, ownerEmail) {
  const { data, error } = await supabase.from('auto_file_exceptions').select('sender_email').eq('owner_email', ownerEmail);
  if (error) {
    // Unknown exceptions -> file nothing rather than risk re-filing a sender Grant rescued.
    throw new Error(`auto-file: could not load exceptions: ${error.message}`);
  }
  return new Set((data || []).map((r) => normalizeEmail(r.sender_email)));
}

export async function proposeNoise({ callClaude, emails }) {
  if (emails.length === 0) return [];
  const list = emails.map((e, i) =>
    `${i}|From: ${e.from?.emailAddress?.name || ''} <${e.from?.emailAddress?.address || ''}> | Subject: ${e.subject || ''} | Preview: ${(e.bodyPreview || '').slice(0, 120)}`
  ).join('\n');
  const response = await callClaude({
    maxTokens: 600,
    system: `You pick CLEAR inbox noise for Grant Carlson (property management) to move into a "Filed by Bot" folder. Nothing is deleted, but be conservative.

Noise means ONLY: automated confirmations and notifications that need no action (e.g. AppFolio "payment received"/"report is ready", system receipts), newsletters and marketing, order/shipping/receipt emails, calendar auto-replies, out-of-office replies.

NOT noise: anything from a person writing to Grant, anything asking a question or for a decision, invoices or bills, anything about a tenant, property, deal, lender, insurance, legal or government matter, security or account alerts, and anything you are unsure about.

Return ONLY a JSON array of the index numbers that are clear noise, e.g. [0, 4]. Return [] if none.`,
    messages: [{ role: 'user', content: list }],
  });
  const match = responseText(response).match(/\[[\s\S]*?\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed.filter((n) => Number.isInteger(n) && n >= 0 && n < emails.length) : [];
  } catch {
    return [];
  }
}

// Files noise for today's digest. `savedItems` are the digest_items rows for
// `emails` (matched by graph_message_id). Returns { filed, kept } where filed
// rows now carry filed_message_id. Never throws.
export async function autoFileNoise({
  supabase, graph, token, ownerEmail, callClaude, emails, savedItems,
  correspondentStats, surfacedText, authFlaggedIds = new Set(), resolveFolderId, now = new Date(),
}) {
  try {
    const exceptions = await loadExceptions(supabase, ownerEmail);
    const candidates = await proposeNoise({ callClaude, emails });
    const byMessage = new Map((savedItems || []).map((i) => [i.graph_message_id, i]));
    const toFile = [];
    const kept = [];
    for (const idx of candidates) {
      const email = emails[idx];
      const reason = keepReason(email, { correspondentStats, exceptions, surfacedText, authFlaggedIds });
      if (reason) kept.push({ email, reason });
      else if (byMessage.get(email.id)) toFile.push({ email, item: byMessage.get(email.id) });
    }
    if (toFile.length === 0) return { filed: [], kept };

    const folderId = await resolveFolderId();
    const filed = [];
    for (const { email, item } of toFile.slice(0, MAX_FILED_PER_DAY)) {
      try {
        const moved = await graph(token, `/users/${ownerEmail}/messages/${email.id}/move`, 'POST', { destinationId: folderId });
        const fields = { action_status: 'filed', filed_message_id: moved?.id || email.id, filed_at: now.toISOString() };
        await supabase.from('digest_items').update(fields).eq('id', item.id);
        filed.push({ ...item, ...fields });
      } catch (err) {
        console.error('auto-file: move failed', { id: email.id, error: err.message });
      }
    }
    return { filed, kept };
  } catch (err) {
    console.error('auto-file: skipped', err.message);
    return { filed: [], kept: [], error: err.message };
  }
}

// Puts one filed email back in the Inbox and remembers its sender so it is
// never filed again.
export async function putBack({ supabase, graph, token, ownerEmail, item }) {
  if (item.action_status !== 'filed' || !item.filed_message_id) {
    throw new Error('That email is not in Filed by Bot anymore.');
  }
  const moved = await graph(token, `/users/${ownerEmail}/messages/${item.filed_message_id}/move`, 'POST', { destinationId: 'inbox' });
  await supabase
    .from('digest_items')
    .update({ action_status: 'restored', graph_message_id: moved?.id || item.graph_message_id, filed_message_id: null })
    .eq('id', item.id);
  const sender = normalizeEmail(item.sender_email || '');
  if (sender) {
    await supabase
      .from('auto_file_exceptions')
      .upsert({ owner_email: ownerEmail, sender_email: sender }, { onConflict: 'owner_email,sender_email' });
  }
  return { sender };
}
