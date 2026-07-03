import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { waitUntil } from '@vercel/functions';

const CHANNEL_ID = 'C0AS84GA607'; // #inbox-digest
const OWNER_EMAIL = 'grant@milestoneproperties.net';
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
    console.error('Failed to save email to memory:', {
      graph_message_id: email.id,
      subject: email.subject,
      error
    });
    return null;
  }

  return data;
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
    console.error('Failed to load existing thread memory:', {
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
    console.error('Failed to count thread messages:', {
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
    console.error('Failed to upsert thread memory:', {
      graph_conversation_id: email.conversationId,
      subject: email.subject,
      error
    });
    return null;
  }

  return data;
}

async function createDigestRun({ totalEmails, savedEmails }) {
  const { data, error } = await supabase
    .from('digest_runs')
    .insert({
      owner_email: OWNER_EMAIL,
      slack_channel_id: CHANNEL_ID,
      total_emails: totalEmails,
      saved_emails: savedEmails,
      status: 'started'
    })
    .select()
    .single();

  if (error) {
    console.error('Failed to create digest run:', { error });
    return null;
  }

  return data;
}

async function updateDigestRun(digestRunId, updates) {
  if (!digestRunId) return;

  const { error } = await supabase
    .from('digest_runs')
    .update({
      ...updates,
      updated_at: new Date().toISOString()
    })
    .eq('id', digestRunId);

  if (error) {
    console.error('Failed to update digest run:', {
      digest_run_id: digestRunId,
      error
    });
  }
}

async function saveDigestItems(digestRunId, emails) {
  if (!digestRunId || emails.length === 0) return [];

  const items = emails.map((email, index) => {
    const sender = email.from?.emailAddress || {};

    return {
      digest_run_id: digestRunId,
      item_number: index + 1,
      graph_message_id: email.id,
      graph_conversation_id: email.conversationId || null,
      sender_name: sender.name || null,
      sender_email: sender.address || null,
      subject: email.subject || null,
      received_at: email.receivedDateTime || null,
      classification: 'digest_candidate',
      action_status: 'open',
      raw_digest_input: {
        body_preview: email.bodyPreview || null,
        importance: email.importance || null,
        is_read: email.isRead ?? null,
        has_attachments: email.hasAttachments ?? false
      }
    };
  });

  const { data, error } = await supabase
    .from('digest_items')
    .insert(items)
    .select();

  if (error) {
    console.error('Failed to save digest items:', {
      digest_run_id: digestRunId,
      error
    });
    return [];
  }

  return data || [];
}

function parseJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch {}

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function parseJsonArray(text) {
  const normalizedText = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(normalizedText);
    return Array.isArray(parsed) ? parsed : null;
  } catch {}

  const match = normalizedText.match(/\[[\s\S]*\]/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeEntityName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeEntityType(entityType) {
  const allowedTypes = new Set([
    'property',
    'person',
    'vendor',
    'tenant',
    'invoice',
    'deadline',
    'insurance',
    'financial_statement',
    'project',
    'legal_issue',
    'maintenance_issue',
    'leasing_issue',
    'system',
    'other'
  ]);
  return allowedTypes.has(entityType) ? entityType : 'other';
}

function normalizeConfidence(confidence) {
  const numericConfidence = Number(confidence);
  if (!Number.isFinite(numericConfidence)) return null;
  return Math.max(0, Math.min(1, numericConfidence));
}

async function saveEntityMention(entityCandidate) {
  const normalizedName = normalizeEntityName(entityCandidate.name);
  if (!entityCandidate.entity_type || !entityCandidate.name || !normalizedName) return null;

  const now = new Date().toISOString();
  const entityType = normalizeEntityType(entityCandidate.entity_type);
  const confidence = normalizeConfidence(entityCandidate.confidence);
  const { data: entity, error: entityError } = await supabase
    .from('entities')
    .upsert({
      owner_email: OWNER_EMAIL,
      entity_type: entityType,
      name: entityCandidate.name,
      normalized_name: normalizedName,
      last_seen_at: now,
      updated_at: now,
      metadata: {
        latest_confidence: confidence
      }
    }, {
      onConflict: 'owner_email,entity_type,normalized_name'
    })
    .select()
    .single();

  if (entityError) {
    console.error('Failed to save entity:', {
      entity_type: entityType,
      name: entityCandidate.name,
      error: entityError
    });
    return null;
  }

  const { error: mentionError } = await supabase
    .from('entity_mentions')
    .upsert({
      entity_id: entity.id,
      graph_message_id: entityCandidate.graph_message_id || null,
      graph_conversation_id: entityCandidate.graph_conversation_id || null,
      source_type: 'email_preview',
      mention_text: entityCandidate.context || null,
      confidence,
      metadata: {
        subject: entityCandidate.subject || null
      }
    }, {
      onConflict: 'entity_id,graph_message_id,source_type'
    });

  if (mentionError) {
    console.error('Failed to save entity mention:', {
      entity_id: entity.id,
      graph_message_id: entityCandidate.graph_message_id,
      error: mentionError
    });
    return null;
  }

  return entity;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function extractEntityCandidatesBatch(anthropic, emails) {
  if (emails.length === 0) return [];

  const extractionInput = emails.map((email, index) => (
    `${index + 1}. source_index: ${index}\n` +
    `graph_message_id: ${email.id}\n` +
    `conversation_id: ${email.conversationId || ''}\n` +
    `from: ${email.from?.emailAddress?.name || ''} <${email.from?.emailAddress?.address || ''}>\n` +
    `subject: ${email.subject || ''}\n` +
    `importance: ${email.importance || ''}\n` +
    `has_attachments: ${email.hasAttachments ?? ''}\n` +
    `preview: ${(email.bodyPreview || '').slice(0, 600)}`
  )).join('\n\n');

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2500,
    system: `Extract durable business entities from Outlook email previews for Grant Carlson at Milestone Properties.

Return ONLY a valid JSON array. Each item must have:
{
  "entity_type": "property" | "person" | "vendor" | "tenant" | "invoice" | "deadline" | "insurance" | "financial_statement" | "project" | "legal_issue" | "maintenance_issue" | "leasing_issue" | "system" | "other",
  "name": "specific entity name",
  "source_index": 0,
  "context": "brief reason this entity matters",
  "confidence": 0.0
}

Be conservative but useful. Prefer specific property names, vendor/company names, tenant/person names, invoice/deadline references, insurance items, financial statement requests or reports, projects, and issue types that will help future retrieval.`,
    messages: [{
      role: 'user',
      content: `Extract at most 8 entities from these email previews. Return raw JSON only, with no markdown fences:\n\n${extractionInput}`,
    }],
  });

  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim();
  const parsed = parseJsonArray(text);

  if (!parsed) {
    console.error('Failed to parse entity extraction response:', { response: text });
    return [];
  }

  return parsed.map(candidate => {
    const sourceIndex = Number(candidate.source_index);
    const email = Number.isInteger(sourceIndex) ? emails[sourceIndex] : null;
    return {
      ...candidate,
      graph_message_id: email?.id || null,
      graph_conversation_id: email?.conversationId || null,
      subject: email?.subject || null
    };
  });
}

async function extractEntitiesFromEmails(anthropic, emails) {
  const maxEmailsForExtraction = 20;
  const emailsForExtraction = emails.slice(0, maxEmailsForExtraction);
  if (emailsForExtraction.length === 0) return [];

  const candidates = [];
  for (const batch of chunkArray(emailsForExtraction, 4)) {
    try {
      const batchCandidates = await extractEntityCandidatesBatch(anthropic, batch);
      candidates.push(...batchCandidates);
    } catch (error) {
      console.error('Entity extraction batch failed:', { error });
    }
  }

  const savedEntities = [];
  for (const entityCandidate of candidates) {
    try {
      const saved = await saveEntityMention(entityCandidate);
      if (saved) savedEntities.push(saved);
    } catch (error) {
      console.error('Entity save failed:', { entityCandidate, error });
    }
  }

  if (emails.length > maxEmailsForExtraction) {
    console.log(`Skipped entity extraction for ${emails.length - maxEmailsForExtraction} emails due to per-digest cap.`);
  }

  return savedEntities;
}

async function summarizeThreadMemory(anthropic, conversationId) {
  const { data: messages, error } = await supabase
    .from('email_messages')
    .select('subject,sender_name,sender_email,received_at,body_preview,importance,is_read')
    .eq('graph_conversation_id', conversationId)
    .order('received_at', { ascending: false })
    .limit(12);

  if (error) {
    console.error('Failed to load thread messages for summary:', {
      graph_conversation_id: conversationId,
      error
    });
    return null;
  }

  if (!messages || messages.length === 0) return null;

  const chronologicalMessages = [...messages].reverse();
  const threadInput = chronologicalMessages.map((message, index) => (
    `${index + 1}. ${message.received_at || 'unknown date'} | ` +
    `From: ${message.sender_name || message.sender_email || 'Unknown'} <${message.sender_email || ''}> | ` +
    `Subject: ${message.subject || '(no subject)'} | ` +
    `Importance: ${message.importance || 'normal'} | ` +
    `Read: ${message.is_read} | ` +
    `Preview: ${(message.body_preview || '').slice(0, 500)}`
  )).join('\n');

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 700,
    system: `You summarize business email threads into durable memory for Grant Carlson at Milestone Properties.

Return ONLY valid JSON with this shape:
{
  "current_summary": "one compact paragraph, max 80 words",
  "open_items": ["short action/waiting item", "..."],
  "status": "active" | "waiting" | "done" | "stale"
}

Use only the email previews provided. If previews are too thin, say what is known and keep open_items conservative.`,
    messages: [{
      role: 'user',
      content: `Summarize this Outlook conversation from saved previews:\n\n${threadInput}`,
    }],
  });

  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim();
  const parsed = parseJsonObject(text);

  if (!parsed?.current_summary) {
    console.error('Failed to parse thread summary response:', {
      graph_conversation_id: conversationId,
      response: text
    });
    return null;
  }

  const openItems = Array.isArray(parsed.open_items) ? parsed.open_items : [];
  const allowedStatuses = new Set(['active', 'waiting', 'done', 'stale']);
  const status = allowedStatuses.has(parsed.status) ? parsed.status : 'active';

  const { data, error: updateError } = await supabase
    .from('email_threads')
    .update({
      current_summary: parsed.current_summary,
      open_items: openItems,
      status,
      summary_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('graph_conversation_id', conversationId)
    .select()
    .single();

  if (updateError) {
    console.error('Failed to update thread summary:', {
      graph_conversation_id: conversationId,
      error: updateError
    });
    return null;
  }

  return data;
}

async function summarizeThreadMemories(anthropic, emails) {
  const conversationIds = [
    ...new Set(emails.map(email => email.conversationId).filter(Boolean))
  ];
  const maxThreadsPerDigest = 12;
  const summarizedThreads = [];

  for (const conversationId of conversationIds.slice(0, maxThreadsPerDigest)) {
    try {
      const summary = await summarizeThreadMemory(anthropic, conversationId);
      if (summary) summarizedThreads.push(summary);
    } catch (error) {
      console.error('Thread summarization failed:', {
        graph_conversation_id: conversationId,
        error
      });
    }
  }

  if (conversationIds.length > maxThreadsPerDigest) {
    console.log(`Skipped ${conversationIds.length - maxThreadsPerDigest} thread summaries due to per-digest cap.`);
  }

  return summarizedThreads;
}

async function runDigest() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing Supabase environment variables: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY');
  }

  const token = await getGraphToken();

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const url = `/users/${OWNER_EMAIL}/mailFolders/Inbox/messages`
    + `?$top=50`
    + `&$select=id,conversationId,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,body,bodyPreview,importance,hasAttachments`
    + `&$filter=receivedDateTime ge ${since}`
    + `&$orderby=receivedDateTime desc`;

  const result = await graph(token, url);
  const emails = result.value || [];

  const savedEmails = [];
  const savedThreads = [];

  for (const email of emails) {
    const saved = await saveEmailToMemory(email);
    if (saved) {
      savedEmails.push(saved);
      const savedThread = await upsertThreadMemory(email);
      if (savedThread) savedThreads.push(savedThread);
    }
  }

  console.log(`Saved ${savedEmails.length}/${emails.length} emails to memory.`);
  console.log(`Updated ${savedThreads.length}/${savedEmails.length} thread memories.`);

  const digestRun = await createDigestRun({
    totalEmails: emails.length,
    savedEmails: savedEmails.length
  });

  if (emails.length === 0) {
    const digestTs = await slackPost('*Morning Digest* — No new emails in the last 24 hours. ✅');
    await updateDigestRun(digestRun?.id, {
      slack_thread_ts: digestTs || null,
      run_completed_at: new Date().toISOString(),
      status: 'no_emails'
    });
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
    const digestTs = await slackPost(`*Morning Digest* — No actionable emails in the last 24 hours.${archivedNote} ✅`);
    await updateDigestRun(digestRun?.id, {
      slack_thread_ts: digestTs || null,
      run_completed_at: new Date().toISOString(),
      included_count: 0,
      actionable_count: 0,
      archived_count: archivedCount,
      status: 'no_actionable'
    });
    return;
  }

  const summarizedThreads = await summarizeThreadMemories(anthropic, filteredEmails);
  console.log(`Summarized ${summarizedThreads.length} thread memories.`);

  const savedEntities = await extractEntitiesFromEmails(anthropic, filteredEmails);
  console.log(`Saved ${savedEntities.length} entity mentions.`);

  const savedDigestItems = await saveDigestItems(digestRun?.id, filteredEmails);
  console.log(`Saved ${savedDigestItems.length}/${filteredEmails.length} digest item mappings.`);

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
  await updateDigestRun(digestRun?.id, {
    slack_thread_ts: digestTs || null,
    run_completed_at: new Date().toISOString(),
    included_count: filteredEmails.length,
    archived_count: archivedCount,
    status: 'posted'
  });

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
