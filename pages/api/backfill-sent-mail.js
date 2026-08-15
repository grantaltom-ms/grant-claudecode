import { supabase } from '../../lib/supabase';
import { getGraphToken, graph, graphAbsolute } from '../../lib/graph';
import { extractBodyFields } from '../../lib/email-parse';
import { upsertThreadMemory } from '../../lib/email-thread-memory';

const OWNER_EMAIL = 'grant@milestoneproperties.net';

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

export async function runSentMailBackfill({ days = 180, maxMessages = 250 } = {}) {
  const token = await getGraphToken();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const select = 'id,conversationId,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,body,bodyPreview,importance,hasAttachments';

  const initialPath = `/users/${OWNER_EMAIL}/mailFolders/SentItems/messages`
    + `?$top=50`
    + `&$select=${select}`
    + `&$filter=sentDateTime ge ${since}`
    + `&$orderby=sentDateTime desc`;
  let nextLink = null;
  let fetched = 0;
  let savedEmails = 0;
  let updatedThreads = 0;
  const errors = [];

  while (fetched < maxMessages) {
    const result = nextLink ? await graphAbsolute(token, nextLink) : await graph(token, initialPath);
    const emails = result.value || [];

    for (const email of emails) {
      if (fetched >= maxMessages) break;
      fetched += 1;

      const saved = await saveSentEmailToMemory(email);
      if (!saved) {
        errors.push({ graph_message_id: email.id, subject: email.subject });
        continue;
      }

      savedEmails += 1;
      // Direction-agnostic: for a SentItems message, email.from is the owner
      // and toRecipients/ccRecipients are the external contacts, so this
      // correctly folds sent mail into participant_emails/last_message_at.
      const savedThread = await upsertThreadMemory(supabase, OWNER_EMAIL, email);
      if (savedThread) updatedThreads += 1;
    }

    nextLink = result['@odata.nextLink'] || null;
    if (!nextLink) break;
  }

  return {
    ok: errors.length === 0,
    supabase_project_ref: projectRefFromUrl(),
    days,
    max_messages: maxMessages,
    fetched,
    saved_emails: savedEmails,
    updated_threads: updatedThreads,
    error_count: errors.length,
    errors: errors.slice(0, 10),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).end();
  if (!verifyCronRequest(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const days = boundedInteger(req.query.days, 180, 730);
    const maxMessages = boundedInteger(req.query.max, 250, 1000);
    const result = await runSentMailBackfill({ days, maxMessages });
    return res.status(200).json(result);
  } catch (error) {
    console.error('Sent mail backfill failed:', error);
    return res.status(500).json({
      ok: false,
      supabase_project_ref: projectRefFromUrl(),
      error: error.message,
    });
  }
}
