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

function decodeBase64Text(contentBytes) {
  if (!contentBytes) return null;
  try {
    return Buffer.from(contentBytes, 'base64').toString('utf8').replace(/\s+/g, ' ').trim();
  } catch {
    return null;
  }
}

function sanitizeText(value) {
  if (value == null) return null;
  return String(value)
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isTextLikeAttachment(attachment) {
  const contentType = (attachment.contentType || '').toLowerCase();
  const name = (attachment.name || '').toLowerCase();
  return (
    contentType.startsWith('text/')
    || contentType.includes('json')
    || contentType.includes('csv')
    || contentType.includes('xml')
    || name.endsWith('.txt')
    || name.endsWith('.csv')
    || name.endsWith('.json')
    || name.endsWith('.xml')
    || name.endsWith('.md')
  );
}

function attachmentChunkText(attachmentRow) {
  return [
    `Attachment: ${attachmentRow.name || ''}`,
    `Content type: ${attachmentRow.content_type || ''}`,
    `Size bytes: ${attachmentRow.size_bytes || 0}`,
    `Inline: ${attachmentRow.is_inline}`,
    attachmentRow.content_text ? `Extracted text: ${attachmentRow.content_text}` : 'Extracted text: unavailable',
  ].join('\n');
}

async function loadMessagesWithAttachments(maxMessages) {
  const { data, error } = await supabase
    .from('email_messages')
    .select('id, graph_message_id, graph_conversation_id, subject, received_at')
    .eq('owner_email', OWNER_EMAIL)
    .eq('has_attachments', true)
    .order('received_at', { ascending: false })
    .limit(maxMessages);

  if (error) throw new Error(`Attachment message lookup failed: ${error.message}`);
  return data || [];
}

async function loadAttachmentContent(token, message, attachment) {
  if (!isTextLikeAttachment(attachment) || (attachment.size || 0) > 250_000) return null;

  try {
    const fullAttachment = await graph(
      token,
      `/users/${OWNER_EMAIL}/messages/${message.graph_message_id}/attachments/${attachment.id}`
    );
    return decodeBase64Text(fullAttachment.contentBytes);
  } catch (error) {
    console.error('Attachment content extraction failed:', {
      graph_message_id: message.graph_message_id,
      attachment_id: attachment.id,
      error,
    });
    return null;
  }
}

async function saveAttachment(message, attachment, contentText) {
  const { data, error } = await supabase
    .from('email_attachments')
    .upsert({
      message_id: message.id,
      graph_message_id: message.graph_message_id,
      graph_attachment_id: attachment.id,
      owner_email: OWNER_EMAIL,
      name: sanitizeText(attachment.name),
      content_type: sanitizeText(attachment.contentType),
      size_bytes: attachment.size || null,
      is_inline: attachment.isInline ?? false,
      content_text: sanitizeText(contentText),
      metadata: {
        odata_type: sanitizeText(attachment['@odata.type']),
        last_modified_date_time: sanitizeText(attachment.lastModifiedDateTime),
        text_extraction: contentText ? 'text_like_attachment' : 'metadata_only',
        message_subject: sanitizeText(message.subject),
      },
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'graph_message_id,graph_attachment_id'
    })
    .select()
    .single();

  if (error) return { ok: false, error };
  return { ok: true, attachment: data, extracted_text: Boolean(contentText) };
}

async function saveAttachmentChunk(message, attachmentRow) {
  const { error } = await supabase
    .from('memory_chunks')
    .upsert({
      owner_email: OWNER_EMAIL,
      source_type: attachmentRow.content_text ? 'attachment_text' : 'attachment_metadata',
      source_table: 'email_attachments',
      source_pk: attachmentRow.id,
      source_id: attachmentRow.id,
      message_id: message.id,
      graph_message_id: message.graph_message_id,
      graph_conversation_id: message.graph_conversation_id,
      title: attachmentRow.name || message.subject || 'Email attachment',
      chunk_text: attachmentChunkText(attachmentRow),
      chunk_summary: attachmentRow.content_text
        ? `Text attachment from email: ${message.subject || '(no subject)'}`
        : `Attachment metadata from email: ${message.subject || '(no subject)'}`,
      metadata: {
        content_type: attachmentRow.content_type,
        size_bytes: attachmentRow.size_bytes,
        message_subject: message.subject,
      },
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'owner_email,source_type,source_pk'
    });

  if (error) return { ok: false, error };
  return { ok: true };
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).end();
  if (!verifyCronRequest(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const maxMessages = boundedInteger(req.query.max, 50, 200);
    const messages = await loadMessagesWithAttachments(maxMessages);
    const token = await getGraphToken();

    let attachmentsSeen = 0;
    let savedAttachments = 0;
    let extractedText = 0;
    let savedChunks = 0;
    const errors = [];

    for (const message of messages) {
      try {
        const result = await graph(
          token,
          `/users/${OWNER_EMAIL}/messages/${message.graph_message_id}/attachments?$top=50&$select=id,name,contentType,size,isInline,lastModifiedDateTime`
        );
        for (const attachment of result.value || []) {
          attachmentsSeen += 1;
          const contentText = await loadAttachmentContent(token, message, attachment);
          const saved = await saveAttachment(message, attachment, contentText);
          if (!saved.ok) {
            errors.push({
              graph_message_id: message.graph_message_id,
              attachment_id: attachment.id,
              message: saved.error?.message,
              code: saved.error?.code,
            });
            continue;
          }

          savedAttachments += 1;
          if (saved.extracted_text) extractedText += 1;
          const chunk = await saveAttachmentChunk(message, saved.attachment);
          if (chunk.ok) {
            savedChunks += 1;
          } else {
            errors.push({
              graph_message_id: message.graph_message_id,
              attachment_id: attachment.id,
              message: chunk.error?.message,
              code: chunk.error?.code,
            });
          }
        }
      } catch (error) {
        errors.push({
          graph_message_id: message.graph_message_id,
          subject: message.subject,
          message: error.message,
        });
      }
    }

    return res.status(200).json({
      ok: errors.length === 0,
      supabase_project_ref: projectRefFromUrl(),
      messages_considered: messages.length,
      attachments_seen: attachmentsSeen,
      saved_attachments: savedAttachments,
      extracted_text_attachments: extractedText,
      saved_chunks: savedChunks,
      error_count: errors.length,
      errors: errors.slice(0, 10),
    });
  } catch (error) {
    console.error('Attachment backfill failed:', error);
    return res.status(500).json({
      ok: false,
      supabase_project_ref: projectRefFromUrl(),
      error: error.message,
    });
  }
}
