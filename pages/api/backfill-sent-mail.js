import { createClient } from '@supabase/supabase-js';

const OWNER_EMAIL = 'grant@milestoneproperties.net';
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

let cachedToken = null;
let tokenExpiry = 0;

function verifyCronRequest(req) {
  return req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
}

function boundedInteger(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function projectRefFromUrl() {
  try {
    return new URL(process.env.SUPABASE_URL).hostname.split('.')[0] || null;
  } catch {
    return null;
  }
}

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

async function graph(token, pathOrUrl) {
  const url = pathOrUrl.startsWith('https://')
    ? pathOrUrl
    : `https://graph.microsoft.com/v1.0${pathOrUrl}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  const text = await res.text();
  if (!text) return { success: true };

  const json = JSON.parse(text);
  if (json.error) throw new Error(`Graph error: ${json.error.message}`);
  return json;
}

function htmlToText(html = '') {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractBodyFields(email) {
  const body = email.body || {};
  const content = body.content || null;
  const contentType = (body.contentType || '').toLowerCase();

  if (!content) return { body_text: null, body_html: null };
  if (contentType === 'html') return { body_text: htmlToText(content), body_html: content };
  return { body_text: content, body_html: null };
}

async function saveSentEmailToMemory(email) {
  const sender = email.from?.emailAddress || {};
  const bodyFields = extractBodyFields(email);

  const { data, error } = await supabase
    .from('email_messages')
    .upsert({
      graph_message_id: email.id,
      graph_conversation_id: email.conversationId || null,
      internet_message_id: email.internetMessageId || null,
      owner_email: OWNER_EMAIL,
      folder: 'SentItems',
      subject: email.subject || null,
      sender_name: sender.name || null,
      sender_email: sender.address || OWNER_EMAIL,
      recipients: email.toRecipients || [],
      cc_recipients: email.ccRecipients || [],
      received_at: email.receivedDateTime || email.sentDateTime || null,
      sent_at: email.sentDateTime || null,
      importance: email.importance || null,
      is_read: email.isRead ?? true,
      has_attachments: email.hasAttachments ?? false,
      body_preview: email.bodyPreview || null,
      body_text: bodyFields.body_text,
      body_html: bodyFields.body_html,
      raw_graph_payload: email,
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'graph_message_id',
    })
    .select()
    .single();

  if (error) {
    console.error('Sent mail backfill failed to save email:', {
      graph_message_id: email.id,
      subject: email.subject,
      error,
    });
    return null;
  }

  return data;
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).end();
  if (!verifyCronRequest(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const days = boundedInteger(req.query.days, 180, 730);
    const maxMessages = boundedInteger(req.query.max, 250, 1000);
    const token = await getGraphToken();
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const select = 'id,conversationId,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,body,bodyPreview,importance,hasAttachments';

    let url = `/users/${OWNER_EMAIL}/mailFolders/SentItems/messages`
      + `?$top=50`
      + `&$select=${select}`
      + `&$filter=sentDateTime ge ${since}`
      + `&$orderby=sentDateTime desc`;
    let fetched = 0;
    let savedEmails = 0;
    const errors = [];

    while (url && fetched < maxMessages) {
      const result = await graph(token, url);
      const emails = result.value || [];

      for (const email of emails) {
        if (fetched >= maxMessages) break;
        fetched += 1;

        const saved = await saveSentEmailToMemory(email);
        if (saved) savedEmails += 1;
        else errors.push({ graph_message_id: email.id, subject: email.subject });
      }

      url = result['@odata.nextLink'] || null;
    }

    return res.status(200).json({
      ok: errors.length === 0,
      supabase_project_ref: projectRefFromUrl(),
      days,
      max_messages: maxMessages,
      fetched,
      saved_emails: savedEmails,
      error_count: errors.length,
      errors: errors.slice(0, 10),
    });
  } catch (error) {
    console.error('Sent mail backfill failed:', error);
    return res.status(500).json({
      ok: false,
      supabase_project_ref: projectRefFromUrl(),
      error: error.message,
    });
  }
}
