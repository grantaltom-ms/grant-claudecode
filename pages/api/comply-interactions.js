// pages/api/comply-interactions.js
// Handles Slack Block Kit interaction payloads (button clicks) for the Comply-or-Vacate bot.
// Slack sends application/x-www-form-urlencoded with a `payload` JSON field.

import { waitUntil } from '@vercel/functions';
import {
  COMPLY_CHANNEL_ID,
  verifySlackSignature,
  slackPost,
  slackUpdateMessage,
  getThreadHistory,
  getBotUserId,
  generateNoticePdf,
  uploadPdfToSlack,
  loadState,
  saveState,
  runAgent,
} from '../../lib/comply-agent.js';
import { buildChoiceBlocks, buildApprovalBlocks, buildConversationHistory } from '../../lib/comply-blocks.js';

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return fallback;
  }
}

async function maybeUploadCompletedNotice(state, threadTs) {
  if (!state?.section1 || !state?.section2 || !state?.section3) return;

  try {
    const today = new Date().toISOString().split('T')[0];
    const lastName = (state.tenantName || 'Tenant').split(/[\s,]+/).filter(Boolean).pop();
    const pdfFilename = `${today} - ${state.propertyName || 'Property'} Unit ${state.unitNumber || ''} - ${lastName} - Comply Notice.pdf`;
    const pdfBuffer = await generateNoticePdf(state);
    await uploadPdfToSlack(pdfBuffer, pdfFilename, threadTs);
  } catch (pdfErr) {
    console.error('PDF error in comply-interactions:', pdfErr);
  }
}

async function handleAgentRun({ threadTs, userChoice, skipMessageTs }) {
  const [botUserId, state, threadMessages] = await Promise.all([
    getBotUserId(),
    loadState(threadTs),
    getThreadHistory(COMPLY_CHANNEL_ID, threadTs),
  ]);

  const conversationHistory = buildConversationHistory(threadMessages, botUserId, skipMessageTs);
  await slackPost(COMPLY_CHANNEL_ID, '_On it..._', threadTs);

  const { text: agentResponse, tenantData, sectionApprovals } = await runAgent(
    userChoice,
    conversationHistory,
    state
  );

  const newState = state || {};
  if (tenantData) Object.assign(newState, tenantData);
  for (const { section_number, content } of sectionApprovals) {
    newState[`section${section_number}`] = content;
  }

  const blocks =
    buildApprovalBlocks(agentResponse, threadTs) ??
    buildChoiceBlocks(agentResponse, threadTs);

  await Promise.all([
    slackPost(COMPLY_CHANNEL_ID, agentResponse, threadTs, blocks),
    saveState(threadTs, newState),
  ]);

  await maybeUploadCompletedNotice(newState, threadTs);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);

  if (!verifySlackSignature(req, rawBody)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const payload = parseJson(new URLSearchParams(rawBody).get('payload'));

  if (payload.type !== 'block_actions') return res.status(200).end();

  const action = payload.actions?.[0];
  if (!action) return res.status(200).end();

  // Acknowledge immediately — Slack requires a 200 within 3 seconds
  res.status(200).end();

  waitUntil(
    (async () => {
      try {
        const channelId = payload.channel?.id;
        const messageTs = payload.message?.ts;
        const threadTs = payload.message?.thread_ts || messageTs;
        const userName = payload.user?.name || payload.user?.username || 'manager';

        // ── comply_choice: manager clicked a numbered option button ────────────
        if (action.action_id === 'comply_choice') {
          const { choiceText, threadTs: payloadThreadTs } = parseJson(action.value);
          const resolvedThread = payloadThreadTs || threadTs;

          await slackUpdateMessage(channelId, messageTs, `✅ *${userName}* selected: ${choiceText}`, null);
          await slackPost(COMPLY_CHANNEL_ID, `[USER_CHOICE] ${choiceText}`, resolvedThread);

          await handleAgentRun({
            threadTs: resolvedThread,
            userChoice: choiceText,
            skipMessageTs: messageTs,
          });

        // ── comply_approve: manager approved a section draft ──────────────────
        } else if (action.action_id === 'comply_approve') {
          const { threadTs: payloadThreadTs } = parseJson(action.value);
          const resolvedThread = payloadThreadTs || threadTs;

          await slackUpdateMessage(channelId, messageTs, `✅ *${userName}* approved this section.`, null);
          await slackPost(COMPLY_CHANNEL_ID, `[USER_CHOICE] ✅ Approved`, resolvedThread);

          await handleAgentRun({
            threadTs: resolvedThread,
            userChoice: '✅ Approved',
            skipMessageTs: messageTs,
          });

        // ── comply_revise: manager wants to request changes ──────────────────
        } else if (action.action_id === 'comply_revise') {
          const { threadTs: payloadThreadTs } = parseJson(action.value);
          const resolvedThread = payloadThreadTs || threadTs;

          await slackUpdateMessage(channelId, messageTs, `✏️ *${userName}* is requesting changes.`, null);
          await slackPost(
            COMPLY_CHANNEL_ID,
            `✏️ Sure — please type your requested changes directly in this thread.`,
            resolvedThread
          );
        }
      } catch (err) {
        console.error('comply-interactions error:', err);
        const fallbackThreadTs = payload.message?.thread_ts || payload.message?.ts;
        if (fallbackThreadTs) {
          await slackPost(
            COMPLY_CHANNEL_ID,
            `⚠️ Something went wrong handling that action: ${err.message}`,
            fallbackThreadTs
          );
        }
      }
    })()
  );
}
