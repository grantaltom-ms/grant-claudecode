// pages/api/inbox-interactions.js
// Handles Slack Block Kit interaction payloads (button clicks) for the inbox
// assistant's calendar approval flow. Slack sends application/x-www-form-urlencoded
// with a `payload` JSON field -- this cannot share an endpoint with
// pages/api/inbox-assistant.js, whose event handler does JSON.parse(rawBody)
// unconditionally. action_ids are namespaced calendar_* so other approval
// flows (e.g. email send) can share this endpoint later.

import { waitUntil } from '@vercel/functions';
import { slackPost as _slackPost, slackUpdateMessage } from '../../lib/slack';
import { getGraphToken } from '../../lib/graph';
import { CHANNEL_ID, APPROVER_USER_ID, verifySlackSignature, executeTool } from './inbox-assistant';
import { CALENDAR_ACTIONS, EMAIL_ACTIONS, formatResolvedMessage } from '../../lib/inbox-blocks';

export const config = { api: { bodyParser: false } };

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export function parseInteractionPayload(rawBody) {
  try {
    return JSON.parse(new URLSearchParams(rawBody).get('payload'));
  } catch {
    return null;
  }
}

// Never throws -- a failure to notify Slack must not surface as a 500 to
// Slack's retry logic, and callers already run inside a best-effort waitUntil.
async function post(text, threadTs) {
  try {
    return await _slackPost(process.env.SLACK_BOT_TOKEN, CHANNEL_ID, text, threadTs);
  } catch (err) {
    console.error('inbox-interactions post failed:', err.message);
    return null;
  }
}

async function collapse(messageTs, originalText, outcome) {
  try {
    return await slackUpdateMessage(
      process.env.SLACK_BOT_TOKEN,
      CHANNEL_ID,
      messageTs,
      formatResolvedMessage(originalText, outcome),
      null
    );
  } catch (err) {
    console.error('inbox-interactions collapse failed:', err.message);
    return null;
  }
}

export async function handleCalendarInteraction(payload) {
  const channelId = payload.channel?.id;
  if (channelId !== CHANNEL_ID) return { handled: false, reason: 'wrong_channel' };

  const actionId = payload.actions?.[0]?.action_id;
  if (!actionId || !actionId.startsWith('calendar_')) return { handled: false, reason: 'not_calendar_action' };

  const message = payload.message || {};
  const messageTs = message.ts;
  const original = message.text;
  let value = {};
  try {
    value = JSON.parse(payload.actions[0].value || '{}');
  } catch {
    value = {};
  }
  const threadTs = value.threadTs || message.thread_ts || messageTs;

  const clickerId = payload.user?.id;
  if (clickerId !== APPROVER_USER_ID) {
    await post(
      `⚠️ Ignored a button click from <@${clickerId}> — only <@${APPROVER_USER_ID}> can approve calendar events.`,
      threadTs
    );
    return { handled: true, action: actionId, result: { success: false, message: 'unauthorized_clicker' } };
  }

  const draftId = value.draftId;
  if (!draftId) {
    await post('⚠️ That button has no draft attached.', threadTs);
    return { handled: true, action: actionId, result: { success: false, message: 'missing_draft_id' } };
  }

  if (actionId === CALENDAR_ACTIONS.APPLY) {
    await collapse(messageTs, original, '⏳ Booking…');
    try {
      const token = await getGraphToken();
      const result = await executeTool('apply_calendar_event', { draft_id: draftId }, token, threadTs);
      if (result.success) {
        await collapse(messageTs, original, '✅ Booked by Grant');
        await post('✅ Booked.', threadTs);
      } else {
        await collapse(messageTs, original, `⚠️ ${result.message}`);
        await post(`⚠️ ${result.message}`, threadTs);
      }
      return { handled: true, action: actionId, result };
    } catch (err) {
      await collapse(messageTs, original, '⚠️ Booking failed');
      await post(
        `⚠️ Booking failed: ${err.message}. That draft is now marked failed — tell me to re-stage it if you want to try again.`,
        threadTs
      );
      return { handled: true, action: actionId, result: { success: false, message: err.message } };
    }
  }

  if (actionId === CALENDAR_ACTIONS.DISCARD) {
    await collapse(messageTs, original, '🗑️ Discarded by Grant');
    const result = await executeTool('discard_calendar_event', { draft_id: draftId }, null, threadTs);
    await post(result.success ? '🗑️ Discarded.' : result.message, threadTs);
    return { handled: true, action: actionId, result };
  }

  if (actionId === CALENDAR_ACTIONS.EDIT) {
    await collapse(messageTs, original, '✏️ Grant is editing');
    // Best-effort: an already-resolved draft (already sent/discarded) fails
    // harmlessly here since discard_calendar_event is pending-only.
    await executeTool('discard_calendar_event', { draft_id: draftId }, null, threadTs);
    await post("✏️ What should change? Reply here and I'll re-stage it.", threadTs);
    return { handled: true, action: actionId, result: { success: true } };
  }

  return { handled: false, reason: 'unknown_calendar_action' };
}

// ✍️ Reply on a numbered digest item. Deliberately does NOT draft anything:
// it opens the conversation in-thread and lets the normal typed flow do the
// drafting, so Grant steers the content from the start. The posted message
// names the item as "#N" because runAgent rebuilds history from this thread
// text -- that reference is what lets the model call resolve_digest_item on
// Grant's next message.
export async function handleEmailInteraction(payload) {
  const channelId = payload.channel?.id;
  if (channelId !== CHANNEL_ID) return { handled: false, reason: 'wrong_channel' };

  const actionId = payload.actions?.[0]?.action_id || '';
  if (!actionId.startsWith(EMAIL_ACTIONS.REPLY)) {
    return { handled: false, reason: 'unknown_email_action' };
  }

  const message = payload.message || {};
  const threadTs = message.thread_ts || message.ts;

  const clickerId = payload.user?.id;
  if (clickerId !== APPROVER_USER_ID) {
    await post(
      `⚠️ Ignored a button click from <@${clickerId}> — only <@${APPROVER_USER_ID}> can act on digest items.`,
      threadTs
    );
    return { handled: true, action: actionId, result: { success: false, message: 'unauthorized_clicker' } };
  }

  let value = {};
  try {
    value = JSON.parse(payload.actions[0].value || '{}');
  } catch {
    value = {};
  }
  const itemNumber = value.itemNumber;
  if (!itemNumber) {
    await post('⚠️ That button has no digest item attached.', threadTs);
    return { handled: true, action: actionId, result: { success: false, message: 'missing_item_number' } };
  }

  try {
    const resolved = await executeTool('resolve_digest_item', { item_number: itemNumber }, null, threadTs);
    const item = resolved?.digest_item || {};
    const who = item.sender_name || item.sender_email || 'the sender';
    const subject = item.subject ? ` — "${item.subject}"` : '';
    await post(
      `✍️ *Reply to #${itemNumber}* — ${who}${subject}\n`
        + "What do you want to say? Reply in this thread and I'll draft it for your approval.",
      threadTs
    );
    return { handled: true, action: actionId, result: { success: true, item_number: itemNumber } };
  } catch (err) {
    await post(`⚠️ Couldn't open a reply for #${itemNumber}: ${err.message}`, threadTs);
    return { handled: true, action: actionId, result: { success: false, message: err.message } };
  }
}

export async function handleInteraction(payload) {
  const actionId = payload.actions?.[0]?.action_id || '';
  if (actionId.startsWith('email_')) return handleEmailInteraction(payload);
  return handleCalendarInteraction(payload);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);

  if (!verifySlackSignature(rawBody, req.headers)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Ignore Slack retries -- the first delivery already ACKed and is running.
  if (req.headers['x-slack-retry-num']) {
    return res.status(200).end();
  }

  const payload = parseInteractionPayload(rawBody);
  if (!payload || payload.type !== 'block_actions' || !payload.actions?.[0]) {
    return res.status(200).end();
  }

  // Acknowledge immediately -- Slack requires a 200 within 3 seconds.
  res.status(200).end();

  waitUntil(
    handleInteraction(payload).catch(err => {
      console.error('inbox-interactions error:', err);
      const threadTs = payload.message?.thread_ts || payload.message?.ts;
      if (threadTs) {
        return post(`⚠️ Something went wrong handling that button: ${err.message}`, threadTs);
      }
    })
  );
}
