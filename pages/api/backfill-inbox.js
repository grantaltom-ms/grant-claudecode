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

function collectEmailAddresses(recipients = []) {
  return recipients
    .map(recipient => recipient.emailAddress?.address)
    .filter(Boolean);
}

function collectEmailNames(recipients = []) {
  return recipients
    .map(recipient => recipient.emailAddress?.name)
    .filter(Boolean);
}

async function saveEmailToMemory(email) {
  const sender = email.from?.emailAddress || {};

  const { data, error } = await supabase
    .from('email_messages')
    .upsert({
      graph_message_id: email.id,
      graph_conversation_id: email.conversationId || null,
      internet_message_id: email.internetMessageId || null,
      owner_email: OWNER_EMAIL,
      folder: 'Inbox',
      subject: email.subject || null,
      sender_name: sender.name || null,
      sender_email: sender.address || null,
      recipients: email.toRecipients || [],
      cc_recipients: email.ccRecipients || [],
      received_at: email.receivedDateTime || null,
      sent_at: email.sentDateTime || null,
      importance: email.importance || null,
      is_read: email.isRead ?? null,
      has_attachments: email.hasAttachments ?? false,
      body_preview: email.bodyPreview || null,
      raw_graph_payload: email,
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'graph_message_id'
    })
    .select()
    .single();

  if (error) {
    console.error('Backfill failed to save email:', {
      graph_message_id: email.id,
      subject: email.subject,
      error
    });
    return null;
  }

  return data;
}

async function upsertThreadMemory(email) {
  if (!email.conversationId) return null;

  const sender = email.from?.emailAddress || {};
  const participantEmails = [
    sender.address,
    ...collectEmailAddresses(email.toRecipients),
    ...collectEmailAddresses(email.ccRecipients)
  ].filter(Boolean);
  const participantNames = [
    sender.name,
    ...collectEmailNames(email.toRecipients),
    ...collectEmailNames(email.ccRecipients)
  ].filter(Boolean);

  const { data: existingThread, error: existingError } = await supabase
    .from('email_threads')
    .select('first_message_at,last_message_at,participant_emails,participant_names')
    .eq('graph_conversation_id', email.conversationId)
    .maybeSingle();

  if (existingError) {
    console.error('Backfill failed to load thread memory:', {
      graph_conversation_id: email.conversationId,
      error: existingError
    });
    return null;
  }

  const receivedAt = email.receivedDateTime || email.sentDateTime || null;
  const existingEmails = existingThread?.participant_emails || [];
  const existingNames = existingThread?.participant_names || [];
  const mergedEmails = [...new Set([...existingEmails, ...participantEmails])];
  const mergedNames = [...new Set([...existingNames, ...participantNames])];
  const firstMessageAt = [existingThread?.first_message_at, receivedAt]
    .filter(Boolean)
    .sort()[0] || null;
  const lastMessageCandidates = [existingThread?.last_message_at, receivedAt]
    .filter(Boolean)
    .sort();
  const lastMessageAt = lastMessageCandidates[lastMessageCandidates.length - 1] || null;

  const { count, error: countError } = await supabase
    .from('email_messages')
    .select('id', { count: 'exact', head: true })
    .eq('graph_conversation_id', email.conversationId);

  if (countError) {
    console.error('Backfill failed to count thread messages:', {
      graph_conversation_id: email.conversationId,
      error: countError
    });
  }

  const { data, error } = await supabase
    .from('email_threads')
    .upsert({
      graph_conversation_id: email.conversationId,
      owner_email: OWNER_EMAIL,
      latest_subject: email.subject || null,
      participant_emails: mergedEmails,
      participant_names: mergedNames,
      first_message_at: firstMessageAt,
      last_message_at: lastMessageAt,
      last_graph_message_id: email.id,
      message_count: count || 0,
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'graph_conversation_id'
    })
    .select()
    .single();

  if (error) {
    console.error('Backfill failed to upsert thread memory:', {
      graph_conversation_id: email.conversationId,
      subject: email.subject,
      error
    });
    return null;
  }

  return data;
}

function boundedInteger(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).end();
  if (!verifyCronRequest(req)) return res.status(401).json({ error: 'Unauthorized' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({
      error: 'Missing Supabase environment variables: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY'
    });
  }

  const days = boundedInteger(req.query.days, 14, 90);
  const maxMessages = boundedInteger(req.query.max, 250, 1000);
  const token = await getGraphToken();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const select = 'id,conversationId,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,bodyPreview,importance,hasAttachments';

  let url = `/users/${OWNER_EMAIL}/mailFolders/Inbox/messages`
    + `?$top=50`
    + `&$select=${select}`
    + `&$filter=receivedDateTime ge ${since}`
    + `&$orderby=receivedDateTime desc`;
  let fetched = 0;
  let savedEmails = 0;
  let updatedThreads = 0;
  const errors = [];

  while (url && fetched < maxMessages) {
    const result = await graph(token, url);
    const emails = result.value || [];

    for (const email of emails) {
      if (fetched >= maxMessages) break;
      fetched += 1;

      const saved = await saveEmailToMemory(email);
      if (!saved) {
        errors.push({ graph_message_id: email.id, subject: email.subject });
        continue;
      }

      savedEmails += 1;
      const savedThread = await upsertThreadMemory(email);
      if (savedThread) updatedThreads += 1;
    }

    url = result['@odata.nextLink'] || null;
  }

  return res.status(200).json({
    ok: true,
    days,
    max_messages: maxMessages,
    fetched,
    saved_emails: savedEmails,
    updated_threads: updatedThreads,
    errors,
  });
}
