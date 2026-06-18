// pages/api/comply-vacate.js
// Comply or Vacate Notice Bot — Milestone Properties
// Channel: C0BBG7ZB1MK
// Reviewer: Conor Murphy (U03DB8GBSAH)

import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { waitUntil } from '@vercel/functions';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://augbrysfqwgekfhfokco.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const COMPLY_CHANNEL_ID = 'C0BBG7ZB1MK';
const CONOR_SLACK_ID = 'U03DB8GBSAH';

// ─── Lease section reference ───────────────────────────────────────────────
const LEASE_SECTIONS = {
  unsanitary_hoarding: {
    section: 'Section 3.8 — Use of Leased Premises and Common Areas',
    text: 'Residents must keep the Leased Premises and areas reserved for private use clean and sanitary; trash must be disposed of at least weekly in appropriate receptacles.',
  },
  pest_infestation: {
    section: 'Section 3.8 — Use of Leased Premises and Common Areas; Bed Bug Addendum Section 5.1–5.4',
    text: 'Residents agree to maintain the Leased Premises in a manner that prevents the occurrence of any infestation of insects and vermin. Residents shall cooperate and comply with all pest control efforts.',
  },
  unauthorized_occupant: {
    section: 'Section 1.1 — Parties and Occupants',
    text: 'The apartment will be occupied exclusively by the resident(s) listed above. The Owner/Agent must approve unauthorized occupants living in the premises for longer than 7 consecutive days.',
  },
  criminal_drugs: {
    section: 'Section 2.2 — Zero Tolerance Crime Policy; Crime-Free Addendum Sections 6.1–6.5',
    text: 'Residents shall not engage in drug-related criminal activity on or near the Residential Community, including the illegal manufacture, sale, distribution, use, or possession of a controlled substance. Residents shall not facilitate, use, or permit the Leased Premises to be used for criminal activity.',
  },
  smoking: {
    section: 'Section 10 — Smoke-Free Addendum',
    text: 'All Residents/Occupants, guests and invitees must refrain from all types of smoking within the dwelling and all common areas of the property.',
  },
  unauthorized_pet: {
    section: 'Section 3.5 — Animals',
    text: 'No animals are permitted in the Leased Premises or the Residential Community without the prior written consent of Owner.',
  },
  property_damage: {
    section: 'Section 3.1 — Condition of Premises and Alterations',
    text: "Residents shall maintain the premises in good, clean and tenantable condition throughout the tenancy. Residents agree not to alter, damage, or remove Owner's property.",
  },
  noise_nuisance: {
    section: 'Section 2.1 — Community Policies or Rules',
    text: 'Residents agree not to harass, annoy, or endanger any other resident or person, or create or maintain a nuisance, or disturb the peace or solitude of any other resident.',
  },
  short_term_rental: {
    section: 'Section 2.8 — Short Term Rentals',
    text: 'Residents are prohibited from offering all or part of the Leased Premises for short-term rental, such as through AirBNB, VRBO or other such sites.',
  },
  insurance_lapse: {
    section: 'Section 1.7 — Insurance',
    text: 'Residents are required to purchase personal liability insurance with a minimum coverage amount of $100,000. Failure to maintain personal liability insurance is an incurable breach of this Lease Contract.',
  },
  mold: {
    section: 'Section 8.11 — Mold Addendum Agreement',
    text: 'Resident shall remove any visible moisture accumulation; keep the Leased Premises clean; and promptly notify management in writing of any water leaks, excessive moisture, or mold growth.',
  },
};

// ─── Slack helpers ──────────────────────────────────────────────────────────

function verifySlackSignature(req, rawBody) {
  const timestamp = req.headers['x-slack-request-timestamp'];
  const slackSig = req.headers['x-slack-signature'];
  if (!timestamp || !slackSig) return false;
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) return false;
  const sigBase = `v0:${timestamp}:${rawBody}`;
  const computed = 'v0=' + crypto.createHmac('sha256', SLACK_SIGNING_SECRET).update(sigBase).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(slackSig));
}

async function slackPost(channel, text, thread_ts = null, blocks = null) {
  const body = { channel, text };
  if (thread_ts) body.thread_ts = thread_ts;
  if (blocks) body.blocks = blocks;
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function getThreadHistory(channel, thread_ts) {
  const res = await fetch(
    `https://slack.com/api/conversations.replies?channel=${channel}&ts=${thread_ts}&limit=50`,
    { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } }
  );
  const data = await res.json();
  return data.messages || [];
}

async function getBotUserId() {
  const res = await fetch('https://slack.com/api/auth.test', {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
  });
  const data = await res.json();
  return data.user_id;
}

// ─── Supabase helpers ───────────────────────────────────────────────────────

async function lookupTenant(propertyHint, unitNumber) {
  // Resolve property via aliases
  const aliasRes = await fetch(
    `${SUPABASE_URL}/rest/v1/property_aliases?alias=ilike.*${encodeURIComponent(propertyHint)}*&select=property_id`,
    { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  const aliases = await aliasRes.json();

  // Also try direct property name match
  const propRes = await fetch(
    `${SUPABASE_URL}/rest/v1/properties?name=ilike.*${encodeURIComponent(propertyHint)}*&managed_by_milestone=eq.true&is_group=eq.false&select=id,name,city`,
    { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  const directProps = await propRes.json();

  const aliasIds = Array.isArray(aliases) ? aliases.map((a) => a.property_id) : [];
  const directIds = Array.isArray(directProps) ? directProps.map((p) => p.id) : [];
  const allIds = [...new Set([...aliasIds, ...directIds])];

  if (allIds.length === 0) return { error: 'property_not_found' };

  const idFilter = allIds.map((id) => `property_id.eq.${id}`).join(',');
  const tenantRes = await fetch(
    `${SUPABASE_URL}/rest/v1/tenant_directory?or=(${encodeURIComponent(idFilter)})&unit_number=eq.${encodeURIComponent(unitNumber)}&select=tenant_name,unit_number,email,phone,lease_to,property_id`,
    { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  const tenants = await tenantRes.json();

  if (!Array.isArray(tenants) || tenants.length === 0) return { error: 'tenant_not_found' };

  const propId = tenants[0].property_id;
  const matchedProp = directProps.find((p) => p.id === propId);
  let propertyName = matchedProp?.name || propertyHint;
  let city = matchedProp?.city || '';

  if (!matchedProp) {
    const p2 = await fetch(
      `${SUPABASE_URL}/rest/v1/properties?id=eq.${propId}&select=name,city`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    const p2data = await p2.json();
    if (p2data?.[0]) { propertyName = p2data[0].name; city = p2data[0].city; }
  }

  return { tenants, propertyName, city, unitNumber };
}

// ─── Google Drive ───────────────────────────────────────────────────────────
// Doc creation is handled manually via Claude's Google Drive MCP connector.
// When Conor approves, the bot posts the final notice text in Slack.
// Grant then asks Claude (in the Claude chat) to save it to Drive.

// ─── State helpers ──────────────────────────────────────────────────────────

function parseState(messages, botUserId) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.user !== botUserId) continue;
    const match = (msg.text || '').match(/<!--STATE:(.*?)-->/s);
    if (match) {
      try { return JSON.parse(match[1]); } catch {}
    }
  }
  return null;
}

function encodeState(state) {
  return `<!--STATE:${JSON.stringify(state)}-->`;
}

// ─── System prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a Lease Compliance Assistant for Milestone Properties, a Seattle-area residential property management company. Your job is to help property managers create legally sound 10-Day Notice to Comply or Vacate notices.

You operate in a Slack channel. When a manager reports a lease violation, you:
1. Ask targeted clarifying questions to fully understand the violation
2. Look up the tenant in Supabase to confirm their identity
3. Draft all three sections of Exhibit A for the RHAWA 10-Day Notice to Comply or Vacate
4. Adjust notice language based on the property's municipality (Seattle gets extra legal counsel language, Burien gets its own language, etc.)
5. Iterate with the manager until they approve the draft
6. Tag Conor Murphy for final review
7. Once Conor approves, finalize and save to Google Drive

## Lease Section Reference
The following lease sections are available for Exhibit A, Section 1 citations. Use the exact section name and text — do not modify this language:

${Object.entries(LEASE_SECTIONS)
  .map(([key, val]) => `**${key}**: ${val.section}\n"${val.text}"`)
  .join('\n\n')}

## Municipality Rules
- **Seattle**: 10-day notice. Must include Seattle-specific legal counsel language: "RIGHT TO LEGAL COUNSEL: CITY LAW PROVIDES RENTERS WHO ARE UNABLE TO PAY FOR AN ATTORNEY THE RIGHT TO FREE LEGAL REPRESENTATION IN AN EVICTION LAWSUIT. If you need help understanding this notice or information about your renter rights, call the Renting in Seattle Helpline at (206) 684-5700 or visit www.seattle.gov/rentinginseattle."
- **Burien**: 10-day notice. Must include just cause language. Additional mandatory language beyond state baseline required.
- **SeaTac, Renton, Des Moines, Tacoma**: 10-day notice. State baseline language applies.
- **All jurisdictions**: Notice must include state legal help language (Eviction Defense Screening Line 855-657-8387, NW Justice Project CLEAR Hotline 888-201-1014).

## Notice Exhibit A Structure
**Section 1**: Rental Agreement, Lease, and/or Rules and Regulations applying to your tenancy:
→ Cite the exact lease section(s) that apply. Do not modify lease language.

**Section 2**: Your violation(s) of the Rental Agreement, Lease, and/or Rules and Regulations as follows:
→ Describe the specific violation factually and specifically. Include dates, observations, and relevant details the manager provided.

**Section 3**: You are required to perform the following action(s) by the deadline specified on this notice or you may be liable of unlawful detainer:
→ List clear, specific, measurable corrective actions the tenant must take.

## Tone and format
- Be professional but concise in Slack messages
- When presenting a draft, use clear section headers
- Always confirm tenant identity before drafting
- Flag any violations that might be criminal activity (drugs, violence) — those may warrant a 3-day notice instead of 10-day
- Never include late fees or monetary amounts in a comply or vacate notice
- Always remind the manager that the compliance deadline must be at least 10 days after service

## Review flow
- After manager says the draft looks good: post the full draft and tag @Conor Murphy for review
- After Conor says "approved" (or similar): confirm finalization and indicate Google Doc will be created
- You do not send the notice — you draft it for the manager to print and serve`;

// ─── Agent loop ─────────────────────────────────────────────────────────────

async function runAgent(userMessage, conversationHistory, state) {
  const messages = [
    ...conversationHistory.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  const tools = [
    {
      name: 'lookup_tenant',
      description: 'Look up a tenant in Supabase by property name and unit number. Returns tenant name, lease end date, email, phone, property name, and city.',
      input_schema: {
        type: 'object',
        properties: {
          property_hint: { type: 'string', description: 'Property name or partial name (e.g. "Olympic View", "Ascona")' },
          unit_number: { type: 'string', description: 'Unit number (e.g. "213", "205")' },
        },
        required: ['property_hint', 'unit_number'],
      },
    },
  ];

  let response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    messages,
    tools,
  });

  while (response.stop_reason === 'tool_use') {
    const toolUseBlock = response.content.find((b) => b.type === 'tool_use');
    if (!toolUseBlock) break;

    let toolResult;
    if (toolUseBlock.name === 'lookup_tenant') {
      const { property_hint, unit_number } = toolUseBlock.input;
      toolResult = JSON.stringify(await lookupTenant(property_hint, unit_number));
    } else {
      toolResult = JSON.stringify({ error: 'unknown_tool' });
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseBlock.id, content: toolResult }] });

    response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages,
      tools,
    });
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  return textBlock ? textBlock.text : '(no response)';
}

// ─── Main handler ───────────────────────────────────────────────────────────

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

        let conversationHistory = [];
        let state = null;

        if (!isNewThread) {
          const threadMessages = await getThreadHistory(COMPLY_CHANNEL_ID, thread_ts);
          state = parseState(threadMessages, botUserId);

          for (const msg of threadMessages) {
            if (msg.ts === event.ts) continue;
            const isBot = msg.user === botUserId;
            const cleanText = (msg.text || '').replace(/<!--STATE:.*?-->/gs, '').trim();
            if (!cleanText || cleanText === '_On it..._') continue;
            conversationHistory.push({ role: isBot ? 'assistant' : 'user', content: cleanText });
          }
        }

        // Check if Conor is approving
        const isConorApproval =
          event.user === CONOR_SLACK_ID &&
          /\b(approved?|looks good|good to go|send it|finalize)\b/i.test(event.text || '');

        if (isConorApproval && state?.draft) {
          const today = new Date().toISOString().split('T')[0];
          const lastName = (state.tenantName || 'Tenant').split(' ').pop();
          const docTitle = `${today} - ${state.propertyName || 'Property'} #${state.unitNumber || ''} - ${lastName} - Comply Notice`;
          await slackPost(
            COMPLY_CHANNEL_ID,
            `✅ *Conor approved. Notice is finalized.*\n\n` +
            `*Suggested filename:* \`${docTitle}\`\n\n` +
            `*Final notice text:*\n\`\`\`\n${state.draft}\n\`\`\`\n\n` +
            `_Grant — ask Claude to save this to Drive, or copy the text above into a Google Doc manually. ` +
            `Reminder: serve via USPS Certified Mail if not hand-delivered (required as of July 2025)._`,
            thread_ts
          );
          return;
        }

        const agentResponse = await runAgent(event.text || '', conversationHistory, state);
        const isDraftReady = /exhibit\s*a/i.test(agentResponse);
        let newState = state || {};

        if (isDraftReady) {
          newState.draft = agentResponse;
          await slackPost(
            COMPLY_CHANNEL_ID,
            agentResponse + `\n\n---\n<@${CONOR_SLACK_ID}> — please review the draft above and reply *approved* when ready to finalize.\n` + encodeState(newState),
            thread_ts
          );
        } else {
          await slackPost(
            COMPLY_CHANNEL_ID,
            agentResponse + '\n' + encodeState(newState),
            thread_ts
          );
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
