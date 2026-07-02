// pages/api/comply-interactions.js
// Handles Slack Block Kit interactive button payloads for the Comply-or-Vacate bot.
// Slack sends these as application/x-www-form-urlencoded with a JSON "payload" field.
//
// Interactions URL to set in Slack App config:
//   https://inbox-assistant-one.vercel.app/api/comply-interactions

import { waitUntil } from '@vercel/functions';
import {
  COMPLY_CHANNEL_ID,
  verifySlackSignature,
  slackPost,
  slackUpdateMessage,
  getThreadHistory,
  getBotUserId,
  loadState,
  saveState,
  runAgent,
  generateNoticePdf,
  uploadPdfToSlack,
} from '../../lib/comply-agent.js';
import {
  buildChoiceBlocks,
  buildApprovalBlocks,
  buildConversationHistory,
} from '../../lib/comply-blocks.js';

// Disable Next.js body parser — we need the raw body for Slack signature verification
export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Shared helper: rebuild history, run agent, post response with blocks
async function handleAgentRun({ channelId, threadTs, userChoice, skipMessageTs }) {
  const botUserId = await getBotUserId();
  const state = await loadState(threadTs);
  const threadMessages = await getThreadHistory(COMPLY_CHANNEL_ID, threadTs);

  const conversationHistory = buildConversationHistory(threadMessages, botUserId, skipMessageTs);

  const { text: agentResponse, tenantData, sectionApprovals } = await runAgent(
    userChoice,
    conversationHistory,
    state
  );

  let newState = state || {};
  if (tenantData) Object.assign(newState, tenantData);
  for (const { section_number, content } of sectionApprovals) {
    newState[`section${section_number}`] = content;
  }

  const allSectionsApproved = newState.section1 && newState.section2 && newState.section3;

  const blocks =
    buildApprovalBlocks(agentResponse, threadTs) ??
    buildChoiceBlocks(agentResponse, threadTs);

  await Promise.all([
    slackPost(COMPLY_CHANNEL_ID, agentResponse, threadTs, blocks),
    saveState(threadTs, newState),
  ]);

  if (allSectionsApproved) {
    try {
      const today = new Date().toISOString().split('T')[0];
      const lastName = (newState.tenantName || 'Tenant').split(/[\s,]+/).filter(Boolean).pop();
      const pdfFilename = `${today} - ${newState.propertyName || 'Property'} Unit ${newState.unitNumber || ''} - ${lastName} - Comply Notice.pdf`;
      const pdfBuffer = await generateNoticePdf(newState);
      await uploadPdfToSlack(pdfBuffer, pdfFilename, threadTs);
    } catch (pdfErr) {
      console.error('comply-interactions PDF error:', pdfErr);
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);

  if (!verifySlackSignature(req, rawBody)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Slack sends payload as url-encoded JSON string
  const payload = JSON.parse(new URLSearchParams(rawBody).get('payload') || '{}');

  if (payload.type !== 'block_actions') return res.status(200).end();

  const action = payload.actions?.[0];
  if (!action) return res.status(200).end();

  // Acknowledge immediately — Slack requires a response within 3 seconds
  res.status(200).end();

  const channelId = payload.channel?.id;
  const messageTs = payload.message?.ts;
  const threadTs = payload.message?.thread_ts || messageTs;
  const userName = payload.user?.name || payload.user?.username || 'manager';

  waitUntil(
    (async () => {
      try {
        if (action.action_id === 'comply_choice') {
          // ── User clicked a choice button ──────────────────────────────────
          const { choiceText, threadTs: payloadThread } = JSON.parse(action.value || '{}');
          const resolvedThread = payloadThread || threadTs;

          // Collapse buttons and show what was selected
          await slackUpdateMessage(
            channelId,
            messageTs,
            `✅ *${userName}* selected: _${choiceText}_`
          );

          // Post a [USER_CHOICE] marker so future history rebuilds treat this as a user message
          await slackPost(COMPLY_CHANNEL_ID, `[USER_CHOICE] ${choiceText}`, resolvedThread);

          await slackPost(COMPLY_CHANNEL_ID, '_On it..._', resolvedThread);

          await handleAgentRun({
            channelId,
            threadTs: resolvedThread,
            userChoice: choiceText,
            skipMessageTs: messageTs,
          });

        } else if (action.action_id === 'comply_approve') {
          // ── User clicked Approve on a section draft ───────────────────────
          const { threadTs: payloadThread } = JSON.parse(action.value || '{}');
          const resolvedThread = payloadThread || threadTs;

          // Collapse buttons and mark as approved
          await slackUpdateMessage(
            channelId,
            messageTs,
            `✅ *${userName}* approved this section.`
          );

          // Post [USER_CHOICE] marker for history
          await slackPost(COMPLY_CHANNEL_ID, '[USER_CHOICE] ✅ Approved', resolvedThread);

          await slackPost(COMPLY_CHANNEL_ID, '_On it..._', resolvedThread);

          await handleAgentRun({
            channelId,
            threadTs: resolvedThread,
            userChoice: '✅ Approved',
            skipMessageTs: messageTs,
          });

        } else if (action.action_id === 'comply_revise') {
          // ── User clicked Request changes ──────────────────────────────────
          const { threadTs: payloadThread } = JSON.parse(action.value || '{}');
          const resolvedThread = payloadThread || threadTs;

          // Collapse buttons
          await slackUpdateMessage(
            channelId,
            messageTs,
            `✏️ *${userName}* is requesting changes.`
          );

          // Prompt the user to type their changes — no agent run needed
          await slackPost(
            COMPLY_CHANNEL_ID,
            '✏️ Sure — please type your requested changes directly in this thread and I\'ll revise the section.',
            resolvedThread
          );
        }
      } catch (err) {
        console.error('comply-interactions error:', err);
        try {
          await slackPost(
            COMPLY_CHANNEL_ID,
            `⚠️ Something went wrong handling that action: ${err.message}`,
            threadTs
          );
        } catch (_) {
          // ignore secondary error
        }
      }
    })()
  );
}
