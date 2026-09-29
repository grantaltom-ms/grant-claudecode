// Handles the to-do buttons on a digest: ✅ Done, 💤 Tomorrow, and the
// "Hand off…" menu. Each click acts on one digest_items row, looked up by the
// id carried in the button, then swaps that row's buttons for a one-line
// outcome so the digest shows what has been handled.

import { handoffContacts, itemLabel, tomorrowPacific } from './todo.js';
import { checkSendRateLimit, recordSend } from './send-safety.js';
import { EMAIL_ACTIONS, resolveTodoRow, dropDraftFromRow } from './inbox-blocks.js';
import { removeAutoDraft } from './auto-drafts.js';

export const TODO_ACTION_PREFIXES = [
  EMAIL_ACTIONS.DONE, EMAIL_ACTIONS.SNOOZE, EMAIL_ACTIONS.HANDOFF,
  EMAIL_ACTIONS.REVIEW_DRAFT, EMAIL_ACTIONS.DELETE_DRAFT,
];

export function isTodoAction(actionId = '') {
  return TODO_ACTION_PREFIXES.some((p) => actionId.startsWith(p));
}

function parseJson(value) {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}

export async function loadItem(supabase, itemId) {
  const { data, error } = await supabase
    .from('digest_items')
    .select('id, item_number, graph_message_id, graph_conversation_id, sender_name, sender_email, subject, received_at, action_status, auto_draft_id, auto_draft_body, auto_draft_modified_at')
    .eq('id', itemId)
    .maybeSingle();
  if (error) throw new Error(`Couldn't load that item: ${error.message}`);
  if (!data) throw new Error("That item isn't in the to-do list anymore.");
  return data;
}

async function setStatus(supabase, itemId, fields) {
  const { error } = await supabase
    .from('digest_items')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', itemId);
  if (error) throw new Error(`Couldn't update that item: ${error.message}`);
}

// Forwards the original email to a teammate with a short note from Grant.
async function handOff({ supabase, graph, token, ownerEmail, item, contact }) {
  const limit = await checkSendRateLimit(supabase, ownerEmail);
  if (!limit.allowed) {
    throw new Error(`Daily send limit reached (${limit.count}/${limit.limit}), so nothing was forwarded.`);
  }
  if (!item.graph_message_id) throw new Error('That item has no email attached to forward.');
  await graph(token, `/users/${ownerEmail}/messages/${item.graph_message_id}/forward`, 'POST', {
    comment: `Hi ${contact.name},\n\nCan you take this one? Let me know if you need anything from me.\n\nThanks,\nGrant`,
    toRecipients: [{ emailAddress: { address: contact.email, name: contact.name } }],
  });
  await recordSend(supabase, ownerEmail, [contact.email], item.graph_message_id);
}

// Once an item is closed, its untouched bot draft goes too; an edited one is
// kept (Grant may still want it) and the outcome line says so.
async function tidyDraft(ctx, item) {
  if (!item.auto_draft_id) return '';
  try {
    const result = await removeAutoDraft({ ...ctx, item });
    return result === 'kept_edited' ? ' _(your edited draft was kept)_' : '';
  } catch (err) {
    console.error('tidyDraft failed', { id: item.id, error: err.message });
    return '';
  }
}

// Returns { itemId, outcome, mode } for a to-do click. mode 'resolve' swaps the
// row for the outcome; 'post' posts the outcome in the thread and leaves the
// row; 'dropDraft' removes the row's draft buttons. Throws with a readable message
// on failure; the caller posts it in the digest thread.
export async function runTodoAction({ payload, supabase, graph, getToken, ownerEmail, now = new Date(), env = process.env }) {
  const action = payload.actions[0];
  const actionId = action.action_id || '';

  if (actionId.startsWith(EMAIL_ACTIONS.HANDOFF)) {
    const { itemId, to } = parseJson(action.selected_option?.value);
    const contact = handoffContacts(env).find((c) => c.key === to);
    if (!itemId || !contact) throw new Error("I don't know who that hand-off is for.");
    const item = await loadItem(supabase, itemId);
    await handOff({ supabase, graph, token: await getToken(), ownerEmail, item, contact });
    await setStatus(supabase, itemId, {
      action_status: 'handed_off',
      handed_off_to: contact.name,
      resolved_at: now.toISOString(),
    });
    const note = await tidyDraft({ supabase, graph, token: await getToken(), ownerEmail }, item);
    return { itemId, mode: 'resolve', outcome: `➡️ Forwarded to ${contact.name} — ${itemLabel(item)}${note}` };
  }

  const { itemId } = parseJson(action.value);
  if (!itemId) throw new Error('That button has no item attached.');
  const item = await loadItem(supabase, itemId);

  if (actionId.startsWith(EMAIL_ACTIONS.DONE)) {
    await setStatus(supabase, itemId, { action_status: 'done', resolved_at: now.toISOString() });
    const note = item.auto_draft_id ? await tidyDraft({ supabase, graph, token: await getToken(), ownerEmail }, item) : '';
    return { itemId, mode: 'resolve', outcome: `✅ Done — ${itemLabel(item)}${note}` };
  }
  if (actionId.startsWith(EMAIL_ACTIONS.SNOOZE)) {
    await setStatus(supabase, itemId, { action_status: 'snoozed', snoozed_until: tomorrowPacific(now) });
    return { itemId, mode: 'resolve', outcome: `💤 Back tomorrow — ${itemLabel(item)}` };
  }
  if (actionId.startsWith(EMAIL_ACTIONS.REVIEW_DRAFT)) {
    if (!item.auto_draft_id) throw new Error('That draft is gone (sent or deleted). Use ✍️ Reply to start a new one.');
    return {
      itemId,
      mode: 'post',
      outcome: `📝 *Draft reply to ${itemLabel(item)}* — it's in your Outlook Drafts:\n>>> ${item.auto_draft_body || '(no text saved)'}\n\n`
        + `_Tell me what to change ("shorter", "say we'll decide by Friday", "more formal") and I'll rewrite it, or say "send it". `
        + `[bracketed] parts are blanks for you to fill._ \`ref: ${item.id}\``,
    };
  }
  if (actionId.startsWith(EMAIL_ACTIONS.DELETE_DRAFT)) {
    const result = await removeAutoDraft({ supabase, graph, token: await getToken(), ownerEmail, item, force: true });
    const outcome = result === 'gone'
      ? `The draft for ${itemLabel(item)} was already gone (sent or deleted in Outlook).`
      : `🗑 Deleted the draft for ${itemLabel(item)}. The item is still on your list.`;
    return { itemId, mode: 'dropDraft', outcome };
  }
  throw new Error('Unknown to-do button.');
}

export { resolveTodoRow, dropDraftFromRow };
