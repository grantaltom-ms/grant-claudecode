// Handles the to-do buttons on a digest: ✅ Done, 💤 Tomorrow, and the
// "Hand off…" menu. Each click acts on one digest_items row, looked up by the
// id carried in the button, then swaps that row's buttons for a one-line
// outcome so the digest shows what has been handled.

import { handoffContacts, itemLabel, tomorrowPacific } from './todo.js';
import { checkSendRateLimit, recordSend } from './send-safety.js';
import { EMAIL_ACTIONS, resolveTodoRow } from './inbox-blocks.js';

export const TODO_ACTION_PREFIXES = [EMAIL_ACTIONS.DONE, EMAIL_ACTIONS.SNOOZE, EMAIL_ACTIONS.HANDOFF];

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
    .select('id, item_number, graph_message_id, graph_conversation_id, sender_name, sender_email, subject, received_at, action_status')
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

// Returns { outcome, itemId } for a to-do click. Throws with a readable message
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
    return { itemId, outcome: `➡️ Forwarded to ${contact.name} — ${itemLabel(item)}` };
  }

  const { itemId } = parseJson(action.value);
  if (!itemId) throw new Error('That button has no item attached.');
  const item = await loadItem(supabase, itemId);

  if (actionId.startsWith(EMAIL_ACTIONS.DONE)) {
    await setStatus(supabase, itemId, { action_status: 'done', resolved_at: now.toISOString() });
    return { itemId, outcome: `✅ Done — ${itemLabel(item)}` };
  }
  if (actionId.startsWith(EMAIL_ACTIONS.SNOOZE)) {
    await setStatus(supabase, itemId, { action_status: 'snoozed', snoozed_until: tomorrowPacific(now) });
    return { itemId, outcome: `💤 Back tomorrow — ${itemLabel(item)}` };
  }
  throw new Error('Unknown to-do button.');
}

export { resolveTodoRow };
