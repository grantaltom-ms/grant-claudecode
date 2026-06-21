// pages/api/comply-vacate.js
// Comply or Vacate Notice Bot — Milestone Properties
// Channel: C0BBG7ZB1MK
// Reviewer: Conor Murphy (U03DB8GBSAH)

import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { waitUntil } from '@vercel/functions';
import PDFDocument from 'pdfkit';
import FormData from 'form-data';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SLACK_BOT_TOKEN = process.env.COMPLY_SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.COMPLY_SLACK_SIGNING_SECRET;
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
  const data = await res.json();
  if (!data.ok) {
    const err = new Error(`Slack post failed: ${data.error}`);
    console.error('slackPost error:', data.error, { channel, thread_ts, textLength: text?.length });
    throw err;
  }
  return data;
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
  // Look up directly in tenant_directory using property_name and unit columns
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/tenant_directory?property_name=ilike.*${encodeURIComponent(propertyHint)}*&unit=eq.${encodeURIComponent(unitNumber)}&select=tenant_name,unit,email,phone,lease_to,property_name,property_city`,
    { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  const tenants = await res.json();

  if (!Array.isArray(tenants) || tenants.length === 0) {
    // Try resolving via properties table in case hint doesn't match property_name exactly
    const propRes = await fetch(
      `${SUPABASE_URL}/rest/v1/properties?name=ilike.*${encodeURIComponent(propertyHint)}*&managed_by_milestone=eq.true&is_group=eq.false&select=id,name,city`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    const props = await propRes.json();
    if (!Array.isArray(props) || props.length === 0) return { error: 'property_not_found' };

    // Try each matching property name
    for (const prop of props) {
      const t2 = await fetch(
        `${SUPABASE_URL}/rest/v1/tenant_directory?property_name=ilike.*${encodeURIComponent(prop.name)}*&unit=eq.${encodeURIComponent(unitNumber)}&select=tenant_name,unit,email,phone,lease_to,property_name,property_city`,
        { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
      );
      const t2data = await t2.json();
      if (Array.isArray(t2data) && t2data.length > 0) {
        return { tenants: t2data, propertyName: prop.name, city: prop.city, unitNumber };
      }
    }
    return { error: 'tenant_not_found' };
  }

  return {
    tenants,
    propertyName: tenants[0].property_name,
    city: tenants[0].property_city,
    unitNumber,
  };
}

// ─── PDF generation ─────────────────────────────────────────────────────────

const STATE_BASELINE_LEGAL =
  'State law provides you the right to legal representation and the court may be able to appoint a lawyer to represent you without cost to you if you are a qualifying low-income renter. ' +
  'If you believe you are a qualifying low-income renter and would like an attorney appointed to represent you, please contact the Eviction Defense Screening Line at 855-657-8387 or apply online at https://nwjustice.org/apply-online. ' +
  'For additional resources, call 2-1-1 or the Northwest Justice Project CLEAR Hotline outside King County (888)201-1014 weekdays between 9:15 a.m. – 12:15 p.m., or (888) 387-7111 for seniors (age 60 and over). ' +
  'You may find additional information to help you at http://www.washingtonlawhelp.org. ' +
  'Free or low-cost mediation services to assist in nonpayment of rent disputes before any judicial proceedings occur are also available at dispute resolution centers throughout the state. ' +
  'You can find your nearest dispute resolution center at https://www.resolutionwa.org. ' +
  'State law also provides you the right to receive interpreter services at court.';

const MUNICIPALITY_ADDENDA = {
  seattle:
    'Additional information based on the location of your rental premises in the City of Seattle:\n\n' +
    'RIGHT TO LEGAL COUNSEL: CITY LAW PROVIDES RENTERS WHO ARE UNABLE TO PAY FOR AN ATTORNEY THE RIGHT TO FREE LEGAL REPRESENTATION IN AN EVICTION LAWSUIT.\n\n' +
    'If you need help understanding this notice or information about your renter rights, call the Renting in Seattle Helpline at (206) 684-5700 or visit the web site at www.seattle.gov/rentinginseattle.',
  burien:
    'Additional information based on the location of your rental premises in the City of Burien:\n\n' +
    'Landlords are required to attach Renting in Burien Handbook - Resources when serving this notice to a tenant in the City of Burien. ' +
    'The current version of the Renting in Burien Handbook - Resources can be found at https://www.burienwa.gov/city_hall/laws_regulations/renting_in_burien/information_for_landlords.',
  seatac:
    'Additional information based on the location of your rental premises in the City of SeaTac:\n\n' +
    'SeaTac city code SMC 4.05.040(B) requires that your landlord provides you with a copy of resources found at this web address: ' +
    'https://www.seatacwa.gov/government/city-departments/community-and-economic-development/rental-housing-resources/rental-housing-resources-information',
};

function generateNoticePdf(state) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      bufferPages: true,
      size: 'LETTER',
      margins: { top: 72, bottom: 72, left: 72, right: 72 },
    });

    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const tenantNames = state.tenantName || '___________________________';
    const propertyName = state.propertyName || '___________________________';
    const unitNumber = state.unitNumber || '___';
    const city = (state.city || '') || '___________________________';

    // ── Page 1: Notice Body ──────────────────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(16).text('Milestone Properties');
    doc.font('Helvetica').fontSize(10)
      .text('PO Box 18379, Seattle, WA 98118')
      .text('206-325-1166');
    doc.moveDown(0.5);
    doc.moveTo(72, doc.y).lineTo(540, doc.y).stroke();
    doc.moveDown(0.5);

    doc.font('Helvetica-Bold').fontSize(13)
      .text('10-DAY NOTICE TO COMPLY OR VACATE THE PREMISES', { align: 'center' });
    doc.moveDown(1);

    doc.font('Helvetica').fontSize(10)
      .text(`TO: ${tenantNames}`)
      .text(`Premises: ${propertyName}, Unit ${unitNumber}`)
      .text(`${city}, WA`);
    doc.moveDown(1);

    doc.font('Helvetica').fontSize(10).text(
      'YOU ARE HEREBY NOTIFIED that you are in violation of your rental agreement as described in ' +
      'Exhibit A, attached hereto and incorporated herein by reference. You are required to comply ' +
      'with your rental agreement OR vacate the premises within TEN (10) DAYS from the date of ' +
      'service of this notice.',
      { lineGap: 2 }
    );
    doc.moveDown(1);

    doc.font('Helvetica').fontSize(10)
      .text('Date of Service: _______________________________')
      .text('Compliance Deadline: _______________________________  (10 days from date of service)');
    doc.moveDown(1);

    doc.font('Helvetica').fontSize(10)
      .text('Landlord/Agent: Milestone Properties')
      .text('PO Box 18379, Seattle, WA 98118')
      .text('206-325-1166');
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(10).text('Signature: _______________________________');
    doc.moveDown(1);

    doc.font('Helvetica').fontSize(9).text(STATE_BASELINE_LEGAL, { lineGap: 2 });

    // ── Page 2: Exhibit A ────────────────────────────────────────────────────
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(13).text('EXHIBIT A', { align: 'center' });
    doc.moveDown(0.5);
    doc.moveTo(72, doc.y).lineTo(540, doc.y).stroke();
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(10)
      .text('Section 1 — Rental Agreement, Lease, and/or Rules and Regulations:');
    doc.moveDown(0.25);
    doc.font('Helvetica').fontSize(10).text(state.section1 || '', { lineGap: 2 });
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(10)
      .text('Section 2 — Violation(s) of the Rental Agreement:');
    doc.moveDown(0.25);
    doc.font('Helvetica').fontSize(10).text(state.section2 || '', { lineGap: 2 });
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(10)
      .text('Section 3 — Required Action(s):');
    doc.moveDown(0.25);
    doc.font('Helvetica').fontSize(10).text(state.section3 || '', { lineGap: 2 });

    // ── Page 3: Municipality Addendum (if applicable) ────────────────────────
    const cityLower = (state.city || '').toLowerCase();
    let addendumText = null;
    if (cityLower.includes('seattle')) addendumText = MUNICIPALITY_ADDENDA.seattle;
    else if (cityLower.includes('burien')) addendumText = MUNICIPALITY_ADDENDA.burien;
    else if (cityLower.includes('seatac') || cityLower.includes('sea-tac') || cityLower.includes('sea tac'))
      addendumText = MUNICIPALITY_ADDENDA.seatac;

    if (addendumText) {
      doc.addPage();
      doc.font('Helvetica-Bold').fontSize(12).text('MUNICIPALITY ADDENDUM', { align: 'center' });
      doc.moveDown(1);
      doc.font('Helvetica').fontSize(10).text(addendumText, { lineGap: 2 });
    }

    doc.end();
  });
}

async function uploadPdfToSlack(pdfBuffer, filename, thread_ts) {
  const form = new FormData();
  form.append('token', SLACK_BOT_TOKEN);
  form.append('channels', COMPLY_CHANNEL_ID);
  form.append('thread_ts', thread_ts);
  form.append('filename', filename);
  form.append('filetype', 'pdf');
  form.append('file', pdfBuffer, { filename, contentType: 'application/pdf' });

  const res = await fetch('https://slack.com/api/files.upload', {
    method: 'POST',
    headers: form.getHeaders(),
    body: form.getBuffer(),
  });
  return res.json();
}

// ─── Google Drive ───────────────────────────────────────────────────────────
// Doc creation is handled manually via Claude's Google Drive MCP connector.
// When Conor approves, the bot posts the final notice text in Slack.
// Grant then asks Claude (in the Claude chat) to save it to Drive.

// ─── State helpers ──────────────────────────────────────────────────────────

async function loadState(thread_ts) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/thread_state?thread_ts=eq.${encodeURIComponent(thread_ts)}&select=state`,
    { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0].state : null;
}

async function saveState(thread_ts, state) {
  await fetch(`${SUPABASE_URL}/rest/v1/thread_state`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ thread_ts, state, updated_at: new Date().toISOString() }),
  });
}

// ─── System prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a Lease Compliance Assistant for Milestone Properties, a Seattle-area residential property management company. Your job is to help property managers create legally sound 10-Day Notice to Comply or Vacate notices.

You operate in a Slack channel. When a manager reports a lease violation, you:
1. Ask targeted clarifying questions to fully understand the violation
2. Look up the tenant in Supabase to confirm their identity
3. Draft each of the three Exhibit A sections ONE AT A TIME, getting approval before moving to the next
4. Once all three sections are approved, call record_section_approval for section 3 and announce the PDF is being generated

## Lease Section Reference
The following lease sections are available for Exhibit A, Section 1 citations. Use the exact section name and text — do not modify this language:

${Object.entries(LEASE_SECTIONS)
  .map(([key, val]) => `**${key}**: ${val.section}\n"${val.text}"`)
  .join('\n\n')}

## Municipality Rules

All notices must include this state baseline legal help language in the body:
"State law provides you the right to legal representation and the court may be able to appoint a lawyer to represent you without cost to you if you are a qualifying low-income renter. If you believe you are a qualifying low-income renter and would like an attorney appointed to represent you, please contact the Eviction Defense Screening Line at 855-657-8387 or apply online at https://nwjustice.org/apply-online. For additional resources, call 2-1-1 or the Northwest Justice Project CLEAR Hotline outside King County (888)201-1014 weekdays between 9:15 a.m. – 12:15 p.m., or (888) 387-7111 for seniors (age 60 and over). You may find additional information to help you at http://www.washingtonlawhelp.org. Free or low-cost mediation services to assist in nonpayment of rent disputes before any judicial proceedings occur are also available at dispute resolution centers throughout the state. You can find your nearest dispute resolution center at https://www.resolutionwa.org. State law also provides you the right to receive interpreter services at court."

Municipality-specific addendum language (append after state baseline):

- **WA State / Renton / Des Moines / Tacoma**: No addendum required beyond state baseline above.

- **Seattle**: Add this addendum page:
  "Additional information based on the location of your rental premises in the City of Seattle:
  RIGHT TO LEGAL COUNSEL: CITY LAW PROVIDES RENTERS WHO ARE UNABLE TO PAY FOR AN ATTORNEY THE RIGHT TO FREE LEGAL REPRESENTATION IN AN EVICTION LAWSUIT.
  If you need help understanding this notice or information about your renter rights, call the Renting in Seattle Helpline at (206) 684-5700 or visit the web site at www.seattle.gov/rentinginseattle."

- **Burien**: Add this addendum page:
  "Additional information based on the location of your rental premises in the City of Burien:
  Landlords are required to attach Renting in Burien Handbook - Resources when serving this notice to a tenant in the City of Burien. The current version of the Renting in Burien Handbook - Resources can be found at https://www.burienwa.gov/city_hall/laws_regulations/renting_in_burien/information_for_landlords."
  ⚠️ Also flag to the manager: they must physically attach the Renting in Burien Handbook - Resources document when serving this notice.

- **SeaTac**: Add this addendum page:
  "Additional information based on the location of your rental premises in the City of SeaTac:
  SeaTac city code SMC 4.05.040(B) requires that your landlord provides you with a copy of resources found at this web address: https://www.seatacwa.gov/government/city-departments/community-and-economic-development/rental-housing-resources/rental-housing-resources-information"
  ⚠️ Also flag to the manager: they must print and attach the SeaTac rental housing resources page when serving this notice.

## Notice Exhibit A Structure
**Section 1**: Rental Agreement, Lease, and/or Rules and Regulations applying to your tenancy:
→ Cite the exact lease section(s) that apply. Do not modify lease language.

**Section 2**: Your violation(s) of the Rental Agreement, Lease, and/or Rules and Regulations as follows:
→ Describe the specific violation factually and specifically. Include dates, observations, and relevant details the manager provided.

**Section 3**: You are required to perform the following action(s) by the deadline specified on this notice or you may be liable of unlawful detainer:
→ List clear, specific, measurable corrective actions the tenant must take.

## Section-by-section drafting flow

Work through Exhibit A one section at a time. Never present more than one section at once.

**Step 1 — Section 1 (Lease Citations)**
Once you have confirmed the tenant and have enough detail about the violation, present Section 1 only:

*Section 1 — Draft:*
[cite the exact lease section name and full quoted text]

✅ Approve | ✏️ Reply with changes

**Step 2 — Section 2 (Violation Description)**
When the manager approves Section 1:
1. Call \`record_section_approval\` with section_number=1 and the final approved text
2. Present Section 2 only, using the same format and ✅/✏️ prompt

**Step 3 — Section 3 (Required Actions)**
When the manager approves Section 2:
1. Call \`record_section_approval\` with section_number=2 and the final approved text
2. Present Section 3 only, using the same format and ✅/✏️ prompt

**Step 4 — PDF generation**
When the manager approves Section 3:
1. Call \`record_section_approval\` with section_number=3 and the final approved text
2. Reply: "All three sections approved ✅ Generating the notice PDF now — it will appear in this thread shortly."

If the manager requests changes to any section, revise it and re-present it before proceeding.

## Tone and format
- Be professional but concise in Slack messages
- Always confirm tenant identity before drafting
- Flag any violations that might be criminal activity (drugs, violence) — those may warrant a 3-day notice instead of 10-day
- Never include late fees or monetary amounts in a comply or vacate notice
- When asking a question that has a fixed set of likely answers, present them as a numbered list so the manager can reply with just a number. Example:
  What type of violation is this?
  1. Unauthorized pet
  2. Noise / nuisance
  3. Smoking
  4. Unauthorized occupant
  5. Other — describe below
  Always include an "Other" option when presenting numbered choices.
- You do not send the notice — the manager prints and serves it`;

// ─── Agent loop ─────────────────────────────────────────────────────────────

async function runAgent(userMessage, conversationHistory, state) {
  let tenantData = null;
  const sectionApprovals = [];
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
    {
      name: 'record_section_approval',
      description: 'Call this when the manager has approved the content for a section of Exhibit A. Records the final text for that section.',
      input_schema: {
        type: 'object',
        properties: {
          section_number: { type: 'number', description: '1, 2, or 3' },
          content: { type: 'string', description: 'The complete final approved text for this section' },
        },
        required: ['section_number', 'content'],
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
      const lookupResult = await lookupTenant(property_hint, unit_number);
      toolResult = JSON.stringify(lookupResult);
      if (!lookupResult.error && lookupResult.tenants?.length) {
        const t = lookupResult.tenants[0];
        tenantData = {
          tenantName: t.tenant_name || lookupResult.tenants.map((x) => x.tenant_name).join(' & '),
          propertyName: lookupResult.propertyName || t.property_name,
          unitNumber: lookupResult.unitNumber || t.unit,
          city: lookupResult.city || t.property_city,
        };
      }
    } else if (toolUseBlock.name === 'record_section_approval') {
      const { section_number, content } = toolUseBlock.input;
      sectionApprovals.push({ section_number, content });
      toolResult = JSON.stringify({ ok: true });
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
  return { text: textBlock ? textBlock.text : '(no response)', tenantData, sectionApprovals };
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

        const state = await loadState(thread_ts);
        let conversationHistory = [];

        if (!isNewThread) {
          const threadMessages = await getThreadHistory(COMPLY_CHANNEL_ID, thread_ts);
          for (const msg of threadMessages) {
            if (msg.ts === event.ts) continue;
            const isBot = msg.user === botUserId;
            const cleanText = (msg.text || '').replace(/<!--STATE:.*?-->/gs, '').trim();
            if (!cleanText || cleanText === '_On it..._') continue;
            conversationHistory.push({ role: isBot ? 'assistant' : 'user', content: cleanText });
          }
        }

        const { text: agentResponse, tenantData, sectionApprovals } = await runAgent(event.text || '', conversationHistory, state);
        let newState = state || {};

        if (tenantData) Object.assign(newState, tenantData);
        for (const { section_number, content } of sectionApprovals) {
          newState[`section${section_number}`] = content;
        }

        const allSectionsApproved = newState.section1 && newState.section2 && newState.section3;

        await Promise.all([
          slackPost(COMPLY_CHANNEL_ID, agentResponse, thread_ts),
          saveState(thread_ts, newState),
        ]);

        if (allSectionsApproved) {
          try {
            const today = new Date().toISOString().split('T')[0];
            const lastName = (newState.tenantName || 'Tenant').split(/[\s,]+/).filter(Boolean).pop();
            const pdfFilename = `${today} - ${newState.propertyName || 'Property'} #${newState.unitNumber || ''} - ${lastName} - Comply Notice.pdf`;
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
