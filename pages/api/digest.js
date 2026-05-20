import Anthropic from '@anthropic-ai/sdk';
import { waitUntil } from '@vercel/functions';

const CHANNEL_ID = 'C0AS84GA607'; // #inbox-digest
const OWNER_EMAIL = 'grant@milestoneproperties.net';

// Verify this is a legitimate cron call (Vercel signs cron requests)
function verifyCronRequest(req) {
  return req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`;
}

// --- Graph API helpers ---

let cachedToken = null;
let tokenExpiry = 0;

async function getGraphToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60_000) return cachedToken;
  const res = await fetch(
    `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.AZURE_CLIENT_ID,
        client_secret: process.env.AZURE_CLIENT_SECRET,
        scope: 'https://graph.microsoft.com/.default',
      }),
    }
  );
  const data = await res.json();
  if (!data.access_token) throw new Error(`Graph auth failed: ${JSON.stringify(data)}`);
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

async function graph(token, path, method = 'GET', body = null) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  if (res.status === 202 || res.status === 204) return { success: true };
  const text = await res.text();
  if (!text) return { success: true };
  const json = JSON.parse(text);
  if (json.error) throw new Error(`Graph error: ${json.error.message}`);
  return json;
}

async function archiveEmail(token, messageId) {
  try {
    await graph(token, `/users/${OWNER_EMAIL}/messages/${messageId}/move`, 'POST', {
      destinationId: 'archive',
    });
    return true;
  } catch {
    return false;
  }
}

async function slackPost(text, threadTs = null) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel: CHANNEL_ID,
      text,
      ...(threadTs && { thread_ts: threadTs }),
    }),
  });
  const data = await res.json();
  return data.ts;
}

// --- Digest logic ---

async function runDigest() {
  const token = await getGraphToken();

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const url = `/users/${OWNER_EMAIL}/mailFolders/Inbox/messages`
    + `?$top=50`
    + `&$select=id,subject,from,receivedDateTime,isRead,bodyPreview,importance`
    + `&$filter=receivedDateTime ge ${since}`
    + `&$orderby=receivedDateTime desc`;

  const result = await graph(token, url);
  const emails = result.value || [];

  if (emails.length === 0) {
    await slackPost('*Morning Digest* — No new emails in the last 24 hours. ✅');
    return;
  }

  let triageRulesSection = '';
  try {
    const rules = JSON.parse(process.env.TRIAGE_RULES || '[]');
    if (rules.length > 0) {
      triageRulesSection = `\n\nCUSTOM TRIAGE OVERRIDES — apply these before anything else:\n${rules.map(r => `- ${r}`).join('\n')}`;
    }
  } catch {}

  const today = new Date();
  const anthropic = new Anthropic();

  const spamCheckList = emails.map((e, i) =>
    `${i}|${e.id}|From: ${e.from?.emailAddress?.name} <${e.from?.emailAddress?.address}> | Subject: ${e.subject} | Preview: ${e.bodyPreview?.slice(0, 100)}`
  ).join('\n');

  const spamResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    system: `You are a spam filter for Grant Carlson's business email at Milestone Properties, a property management company.

Return ONLY a JSON array of index numbers (0-based) for emails that are CLEARLY spam or mass solicitation — things like:
- Cold sales outreach with no prior relationship
- Mass marketing emails / newsletters Grant didn't sign up for
- SEO, web design, or digital marketing solicitations
- Phishing attempts or scammy offers
- Generic "we can help your business" cold pitches

Be CONSERVATIVE. When in doubt, do NOT mark as spam. Never mark as spam:
- Any email from a known contact or business Grant works with
- Invoices or payment requests (even from unknown vendors)
- Anything property, tenant, or deal related
- Legal or government notices
- Anything that could be legitimate business correspondence

Return format: [0, 3, 7] or [] if none. Return ONLY the JSON array, nothing else.`,
    messages: [{
      role: 'user',
      content: `Review these emails and return the index numbers of clear spam:\n\n${spamCheckList}`,
    }],
  });

  let archivedCount = 0;
  let filteredEmails = emails;
  try {
    const spamIndices = JSON.parse(spamResponse.content[0].text.trim());
    if (Array.isArray(spamIndices) && spamIndices.length > 0) {
      const archivePromises = spamIndices.map(i => {
        if (emails[i]) return archiveEmail(token, emails[i].id);
        return Promise.resolve(false);
      });
      const results = await Promise.all(archivePromises);
      archivedCount = results.filter(Boolean).length;
      const spamSet = new Set(spamIndices);
      filteredEmails = emails.filter((_, i) => !spamSet.has(i));
    }
  } catch {
    filteredEmails = emails;
  }

  if (filteredEmails.length === 0) {
    const archivedNote = archivedCount > 0 ? ` (${archivedCount} spam emails auto-archived)` : '';
    await slackPost(`*Morning Digest* — No actionable emails in the last 24 hours.${archivedNote} ✅`);
    return;
  }

  const emailList = filteredEmails.map((e, i) => {
    const received = new Date(e.receivedDateTime);
    const daysAgo = Math.floor((today - received) / (1000 * 60 * 60 * 24));
    const ageNote = daysAgo > 0 ? ` (${daysAgo}d ago)` : ' (today)';
    return `${i + 1}. From: ${e.from?.emailAddress?.name || e.from?.emailAddress?.address} <${e.from?.emailAddress?.address}> | Subject: ${e.subject} | Read: ${e.isRead}${ageNote} | Preview: ${e.bodyPreview?.slice(0, 150)}`;
  }).join('\n');

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    system: `You are a morning email triage assistant for Grant Carlson at Milestone Properties, a property management company in the Seattle/Burien/SeaTac area.

Analyze his emails and produce a concise, well-organized Slack digest.

FORMAT:
*🌅 Morning Digest — [Day, Month Date]*

*🔧 System Alerts*
- [Source] — [Issue]: [one-line summary of what broke or needs attention]

*🔴 Action Required*
- [#N] [Sender] — [Subject][property tag if applicable]: [one-line summary of what's needed]

*🟡 FYI / Needs Awareness*
- [Sender] — [Subject][property tag if applicable]: [one-line summary]

OMIT the ⚪ Low Priority / Noise section entirely — do not include it in the digest.

End with: *[N] emails total — [X] need action*

RULES:

SENDER IDENTIFICATION:
- If the sender name is "Milestone Properties" or a generic company name, identify the actual source from the subject/preview (e.g. "AppFolio", "DocuSign", "Internal — [topic]")
- Always use the person's name when available, not just the company

GROUPING:
- Group multiple emails about the same deal, property, or topic under a single indented block
- Format grouped items like:
  *9275 Renton Ave S — Closing*
  ↳ [#1] Merritt Hess — Review and signature requested
  ↳ [#2] Emily Hess — Home inspection report ready
- Only group if 2+ emails clearly relate to the same thing

PROPERTY TAGGING:
- When an email is clearly about a specific property, append a tag: [Renton], [Burien], [SeaTac], [Tukwila], etc.

TIME-SENSITIVE FLAGS:
- If an invoice or deadline is overdue, prepend: ⚠️ OVERDUE —
- If something is due within 48 hours, prepend: 🕐 DUE SOON —

CATEGORIZATION:
- 🔧 System Alerts: Automation errors, Zapier failures, system notifications that indicate something broke
- 🔴 Action Required: Emails that genuinely need Grant to do something — reply, sign, approve, pay, decide
- 🟡 FYI / Needs Awareness: Emails Grant should know about but don't require action yet — reports, forwarded info, colleague updates
- Low Priority / Noise emails (automated confirmations, newsletters, routine system reports, daily delinquency reports that ran fine, Adobe Acrobat comment notifications, AppFolio automated confirmations) — SILENTLY DISCARD. Do not include them in any section.

NUMBERING:
- Assign each email a number [#N] in Action Required items only
- Don't number FYI items

OMIT sections with no emails entirely.${triageRulesSection}`,
    messages: [{
      role: 'user',
      content: `Here are Grant's emails from the last 24 hours. Please triage them:\n\n${emailList}`,
    }],
  });

  let digest = response.content[0].text;

  if (archivedCount > 0) {
    digest += `\n_🗑️ ${archivedCount} spam email${archivedCount > 1 ? 's' : ''} auto-archived_`;
  }

  const digestTs = await slackPost(digest);

  await slackPost(
    '_Reply here to act on any email — e.g. "draft reply to #1", "what does #3 say", "mark #2 as done"_',
    digestTs
  );
}

// --- Handler ---

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).end();

  if (!verifyCronRequest(req)) return res.status(401).json({ error: 'Unauthorized' });

  res.status(200).json({ ok: true });

  waitUntil(
    runDigest().catch(async err => {
      console.error('Digest error:', err);
      await slackPost(`⚠️ Morning digest failed: ${err.message}`).catch(() => {});
    })
  );
}
