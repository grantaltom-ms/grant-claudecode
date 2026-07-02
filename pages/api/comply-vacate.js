// pages/api/comply-vacate.js
// Comply or Vacate Notice Bot — Milestone Properties
// Channel: C0BBG7ZB1MK   Reviewer: Conor Murphy (U03DB8GBSAH)

import { waitUntil } from '@vercel/functions';
import {
  SLACK_BOT_TOKEN,
  COMPLY_CHANNEL_ID,
  verifySlackSignature,
  slackPost,
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = JSON.stringify(req.body);

  if (req.body.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }

  if (!verifySlackSignature(req, rawBody)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = req.body.event;
  if (!event || event.type !== 'message' || event.subtype) return res.status(200).end();
  if (event.channel !== COMPLY_CHANNEL_ID) return res.status(200).end();

  res.status(200).end();

  waitUntil(
    (async () => {
      try {
        const botUserId = await getBotUserId();
        if (event.user === botUserId) return;

        const isNewThread = !event.thread_ts || event.thread_ts === event.ts;
        const thread_ts = event.thread_ts || event.ts;

        await slackPost(COMPLY_CHANNEL_ID, '_On it..._', thread_ts);

        const state = await loadState(thread_ts);
        let conversationHistory = [];

        if (!isNewThread) {
          const threadMessages = await getThreadHistory(COMPLY_CHANNEL_ID, thread_ts);
          // Skip the current event message — it's injected as userMessage below
          conversationHistory = buildConversationHistory(threadMessages, botUserId, event.ts);
        }

        const { text: agentResponse, tenantData, sectionApprovals } = await runAgent(
          event.text || '',
          conversationHistory,
          state
        );

        let newState = state || {};
        if (tenantData) Object.assign(newState, tenantData);
        for (const { section_number, content } of sectionApprovals) {
          newState[`section${section_number}`] = content;
        }

        const allSectionsApproved = newState.section1 && newState.section2 && newState.section3;

        // Attach interactive blocks when appropriate
        const blocks =
          buildApprovalBlocks(agentResponse, thread_ts) ??
          buildChoiceBlocks(agentResponse, thread_ts);

        await Promise.all([
          slackPost(COMPLY_CHANNEL_ID, agentResponse, thread_ts, blocks),
          saveState(thread_ts, newState),
        ]);

        if (allSectionsApproved) {
          try {
            const today = new Date().toISOString().split('T')[0];
            const lastName = (newState.tenantName || 'Tenant').split(/[\s,]+/).filter(Boolean).pop();
            const pdfFilename = `${today} - ${newState.propertyName || 'Property'} Unit ${newState.unitNumber || ''} - ${lastName} - Comply Notice.pdf`;
            const pdfBuffer = await generateNoticePdf(newState);
            await uploadPdfToSlack(pdfBuffer, pdfFilename, thread_ts);
          } catch (pdfErr) {
            console.error('PDF generation/upload error:', pdfErr);
          }
        }
      } catch (err) {
        console.error('comply-vacate error:', err);
        await slackPost(
          COMPLY_CHANNEL_ID,
          `⚠️ Something went wrong: ${err.message}`,
          req.body.event?.thread_ts || req.body.event?.ts
        );
      }
    })()
  );
}

export const config = {
  api: { bodyParser: { type: 'application/json' } },
};
