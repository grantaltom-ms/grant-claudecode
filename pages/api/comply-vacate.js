// pages/api/comply-vacate.js
// Comply or Vacate Notice Bot — Milestone Properties
// Channel: C0BBG7ZB1MK   Reviewer: Conor Murphy (U03DB8GBSAH)

import { waitUntil } from '@vercel/functions';
import {
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

// Leave headroom under vercel.json maxDuration (120s) so we can still post an
// error to Slack instead of dying silently after "_On it..._".
const HANDLER_BUDGET_MS = 100_000;

function withBudget(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s — please try your last message again`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = JSON.stringify(req.body);

  if (req.body.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }

  if (!verifySlackSignature(req, rawBody)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Slack retries when we miss the 3s ACK window. We already ACK immediately;
  // processing a retry duplicates "_On it..._" and can race the first run.
  if (req.headers['x-slack-retry-num']) {
    return res.status(200).end();
  }

  const event = req.body.event;
  if (!event || event.type !== 'message' || event.subtype) return res.status(200).end();
  if (event.channel !== COMPLY_CHANNEL_ID) return res.status(200).end();

  res.status(200).end();

  waitUntil(
    (async () => {
      const thread_ts = event.thread_ts || event.ts;
      try {
        await withBudget(
          (async () => {
            const botUserId = await getBotUserId();
            if (event.user === botUserId) return;

            const isNewThread = !event.thread_ts || event.thread_ts === event.ts;

            await slackPost(COMPLY_CHANNEL_ID, '_On it..._', thread_ts);

            const state = await loadState(thread_ts);
            let conversationHistory = [];

            if (!isNewThread) {
              const threadMessages = await getThreadHistory(COMPLY_CHANNEL_ID, thread_ts);
              // Skip the current event message — it's injected as userMessage below
              conversationHistory = buildConversationHistory(threadMessages, botUserId, event.ts);
            }

            const { text: agentResponse, tenantData, managerName, sectionApprovals } = await runAgent(
              event.text || '',
              conversationHistory,
              state
            );

            let newState = state || {};
            if (managerName) newState.managerName = managerName;
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
          })(),
          HANDLER_BUDGET_MS,
          'comply-vacate'
        );
      } catch (err) {
        console.error('comply-vacate error:', err);
        try {
          await slackPost(
            COMPLY_CHANNEL_ID,
            `⚠️ Something went wrong: ${err.message}`,
            thread_ts
          );
        } catch (postErr) {
          console.error('comply-vacate failed to post error to Slack:', postErr);
        }
      }
    })()
  );
}

export const config = {
  api: { bodyParser: { type: 'application/json' } },
};
