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

async function graph(token, path) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
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
  if (contentType === 'html') {
    return {
      body_text: htmlToText(content),
      body_html: content
    };
  }

  return {
    body_text: content,
    body_html: null
  };
}

async function loadMessagesNeedingBodies(maxMessages) {
  const { data, error } = await supabase
    .from('email_messages')
    .select('id, graph_message_id, subject, received_at, body_preview')
    .eq('owner_email', OWNER_EMAIL)
    .is('body_text', null)
    .order('received_at', { ascending: false })
    .limit(maxMessages);

  if (error) throw new Error(`Email memory lookup failed: ${error.message}`);
  return data || [];
}

async function saveBodyFields(memoryMessage, graphMessage) {
  const bodyFields = extractBodyFields(graphMessage);
  const { error } = await supabase
    .from('email_messages')
    .update({
      body_text: bodyFields.body_text,
      body_html: bodyFields.body_html,
      body_preview: graphMessage.bodyPreview || null,
      raw_graph_payload: {
        ...graphMessage,
        hydrated_body_at: new Date().toISOString()
      },
      updated_at: new Date().toISOString()
    })
    .eq('id', memoryMessage.id);

  if (error) return { ok: false, error };
  return { ok: true, saved_body: Boolean(bodyFields.body_text || bodyFields.body_html) };
}

async function markBodyUnavailable(memoryMessage, reason) {
  const { error } = await supabase
    .from('email_messages')
    .update({
      body_text: memoryMessage.body_preview || '[Body unavailable from Microsoft Graph]',
      raw_graph_payload: {
        body_unavailable_at: new Date().toISOString(),
        body_unavailable_reason: reason,
      },
      updated_at: new Date().toISOString()
    })
    .eq('id', memoryMessage.id);

  if (error) return { ok: false, error };
  return { ok: true };
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).end();
  if (!verifyCronRequest(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const maxMessages = boundedInteger(req.query.max, 50, 250);
    const messages = await loadMessagesNeedingBodies(maxMessages);
    const token = await getGraphToken();

    let updated = 0;
    let bodiesSaved = 0;
    const errors = [];

    for (const memoryMessage of messages) {
      try {
        const graphMessage = await graph(
          token,
          `/users/${OWNER_EMAIL}/messages/${memoryMessage.graph_message_id}?$select=id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,body,bodyPreview,importance,hasAttachments`
        );
        const result = await saveBodyFields(memoryMessage, graphMessage);
        if (result.ok) {
          updated += 1;
          if (result.saved_body) bodiesSaved += 1;
        } else {
          errors.push({
            graph_message_id: memoryMessage.graph_message_id,
            subject: memoryMessage.subject,
            message: result.error?.message,
            code: result.error?.code,
          });
        }
      } catch (error) {
        if (error.message.includes('object was not found in the store')) {
          const marked = await markBodyUnavailable(memoryMessage, error.message);
          if (marked.ok) {
            updated += 1;
          } else {
            errors.push({
              graph_message_id: memoryMessage.graph_message_id,
              subject: memoryMessage.subject,
              message: marked.error?.message,
              code: marked.error?.code,
            });
          }
        } else {
          errors.push({
            graph_message_id: memoryMessage.graph_message_id,
            subject: memoryMessage.subject,
            message: error.message,
          });
        }
      }
    }

    return res.status(200).json({
      ok: errors.length === 0,
      supabase_project_ref: projectRefFromUrl(),
      messages_considered: messages.length,
      updated,
      bodies_saved: bodiesSaved,
      error_count: errors.length,
      errors: errors.slice(0, 10),
    });
  } catch (error) {
    console.error('Email body backfill failed:', error);
    return res.status(500).json({
      ok: false,
      supabase_project_ref: projectRefFromUrl(),
      error: error.message,
    });
  }
}
