import { supabase } from '../../lib/supabase';
import { getGraphToken, graph, graphAbsolute } from '../../lib/graph';
import { extractBodyFields } from '../../lib/email-parse';
import { upsertThreadMemory as upsertThreadMemoryShared } from '../../lib/email-thread-memory';

const OWNER_EMAIL = 'grant@milestoneproperties.net';

function verifyCronRequest(req) {
  return req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
}

async function saveEmailToMemory(email) {
  const sender = email.from?.emailAddress || {};
  const bodyFields = extractBodyFields(email);

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
      body_text: bodyFields.body_text,
      body_html: bodyFields.body_html,
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

function safeError(error) {
  return {
    code: error?.code || null,
    message: error?.message || 'Unknown error',
    details: error?.details || null,
    hint: error?.hint || null
  };
}

function projectRefFromUrl() {
  try {
    return new URL(process.env.SUPABASE_URL).hostname.split('.')[0] || null;
  } catch {
    return null;
  }
}

async function upsertThreadMemory(email, threadErrors) {
  return upsertThreadMemoryShared(supabase, OWNER_EMAIL, email, {
    onError: (stage, error) => {
      threadErrors.push({
        stage,
        graph_conversation_id: email.conversationId,
        subject: email.subject,
        error: safeError(error)
      });
    }
  });
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
  const select = 'id,conversationId,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,body,bodyPreview,importance,hasAttachments';

  const initialPath = `/users/${OWNER_EMAIL}/mailFolders/Inbox/messages`
    + `?$top=50`
    + `&$select=${select}`
    + `&$filter=receivedDateTime ge ${since}`
    + `&$orderby=receivedDateTime desc`;
  let nextLink = null;
  let fetched = 0;
  let savedEmails = 0;
  let updatedThreads = 0;
  const errors = [];
  const threadErrors = [];

  while (fetched < maxMessages) {
    const result = nextLink ? await graphAbsolute(token, nextLink) : await graph(token, initialPath);
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
      const savedThread = await upsertThreadMemory(email, threadErrors);
      if (savedThread) updatedThreads += 1;
    }

    nextLink = result['@odata.nextLink'] || null;
    if (!nextLink) break;
  }

  return res.status(200).json({
    ok: true,
    supabase_project_ref: projectRefFromUrl(),
    days,
    max_messages: maxMessages,
    fetched,
    saved_emails: savedEmails,
    updated_threads: updatedThreads,
    errors,
    thread_error_count: threadErrors.length,
    thread_errors: threadErrors.slice(0, 10),
  });
}
