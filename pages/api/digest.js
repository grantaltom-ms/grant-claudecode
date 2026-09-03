import { waitUntil } from '@vercel/functions';
import { supabase } from '../../lib/supabase';
import { getGraphToken, graph, walkDeltaPages } from '../../lib/graph';
import { extractBodyFields, parseAuthResults, isAuthFailure } from '../../lib/email-parse';
import { upsertThreadMemory } from '../../lib/email-thread-memory';
import { slackPost as _slackPost } from '../../lib/slack';
import { buildDigestBlocks, extractDigestItemNumbers } from '../../lib/inbox-blocks';
import { callClaude } from '../../lib/claude';
import { loadCorrespondentStatsMap, normalizeEmail } from '../../lib/correspondent-history';

const CHANNEL_ID = 'C0AS84GA607'; // #inbox-digest
const OWNER_EMAIL = 'grant@milestoneproperties.net';

// Verify this is a legitimate cron call (Vercel signs cron requests)
function verifyCronRequest(req) {
  return req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`;
}

async function archiveEmail(token, messageId) {
  try {
    await graph(token, `/users/${OWNER_EMAIL}/messages/${messageId}/move`, 'POST', {
      destinationId: 'archive',
    });
    return { ok: true };
  } catch (error) {
    console.error('Archive failed:', { messageId, error: error?.message || error });
    return { ok: false, error: error?.message || String(error) };
  }
}

// Heuristic for the specific high-stakes combination auth forensics cares
// about: a request to change how/where money moves. Deliberately narrower
// than "invoice" or "payment" alone, which match plenty of ordinary mail.
const PAYMENT_FRAUD_KEYWORD_PATTERN = /\b(wire transfer|wiring instructions|bank(ing)? details|account number|routing number|payment instructions|update(d)? (my |our )?(payment|banking) (details|info)|new (payment|banking|account) (details|instructions)|ach transfer|remit(tance)? to|change of bank)\b/i;

function looksLikePaymentRequest(text = '') {
  return PAYMENT_FRAUD_KEYWORD_PATTERN.test(text);
}

// Correspondent history enrichment (docs/PLAN-outlook-mcp-inspired-features.md
// follow-on pilot): makes the triage prompt's one-line summaries context-aware
// for frequent/high-value senders, without a second Claude call or a new
// digest section. Same 0-safe env-parsing idiom as lib/send-safety.js's
// resolveMaxSendsPerDay -- an explicit "" or unset falls back to the default,
// anything else must parse as a finite number.
const DEFAULT_HISTORY_MIN_EXCHANGES = 3;
const DEFAULT_HISTORY_WINDOW_DAYS = 180;
const DEFAULT_HISTORY_MAX_MESSAGES = 1000;

function resolveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveMinExchanges() {
  return resolveIntEnv('DIGEST_HISTORY_MIN_EXCHANGES', DEFAULT_HISTORY_MIN_EXCHANGES);
}

function resolveHistoryWindowDays() {
  return resolveIntEnv('DIGEST_HISTORY_WINDOW_DAYS', DEFAULT_HISTORY_WINDOW_DAYS);
}

function resolveHistoryMaxMessages() {
  return resolveIntEnv('DIGEST_HISTORY_MAX_MESSAGES', DEFAULT_HISTORY_MAX_MESSAGES);
}

// Requires at least one outbound message (not just inbound volume) so a
// purely automated one-way sender (DocuSign, a vendor notification address)
// doesn't qualify just by sending 3+ notifications -- that's volume, not the
// ongoing correspondence this feature is meant to surface.
function qualifiesForHistoryNote(stats) {
  return !!stats
    && stats.outbound_count >= 1
    && (stats.inbound_count + stats.outbound_count) >= resolveMinExchanges();
}

// Preserves this file's original contract (never throws, returns undefined
// on failure) -- lib/slack.js's slackPost throws on API failure, which is a
// deliberate behavior difference from the Comply bot's stricter needs, not
// something to introduce here as a side effect of consolidation.
async function slackPost(text, threadTs = null, blocks = null) {
  try {
    const data = await _slackPost(process.env.SLACK_BOT_TOKEN, CHANNEL_ID, text, threadTs, blocks);
    return data.ts;
  } catch (err) {
    console.error('slackPost failed:', err.message);
    return undefined;
  }
}

// --- Digest logic ---

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

async function extractEntityCandidatesBatch(emails) {
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

  const response = await callClaude({
    maxTokens: 2500,
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

async function extractEntitiesFromEmails(emails) {
  const maxEmailsForExtraction = 20;
  const emailsForExtraction = emails.slice(0, maxEmailsForExtraction);
  const skippedCount = Math.max(0, emails.length - maxEmailsForExtraction);
  if (emailsForExtraction.length === 0) return { entities: [], skippedCount };

  const candidates = [];
  for (const batch of chunkArray(emailsForExtraction, 4)) {
    try {
      const batchCandidates = await extractEntityCandidatesBatch(batch);
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

  if (skippedCount > 0) {
    console.log(`Skipped entity extraction for ${skippedCount} emails due to per-digest cap.`);
  }

  return { entities: savedEntities, skippedCount };
}

async function summarizeThreadMemory(conversationId) {
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

  const response = await callClaude({
    maxTokens: 700,
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

async function summarizeThreadMemories(emails) {
  const conversationIds = [
    ...new Set(emails.map(email => email.conversationId).filter(Boolean))
  ];
  const maxThreadsPerDigest = 12;
  const summarizedThreads = [];
  const skippedCount = Math.max(0, conversationIds.length - maxThreadsPerDigest);

  for (const conversationId of conversationIds.slice(0, maxThreadsPerDigest)) {
    try {
      const summary = await summarizeThreadMemory(conversationId);
      if (summary) summarizedThreads.push(summary);
    } catch (error) {
      console.error('Thread summarization failed:', {
        graph_conversation_id: conversationId,
        error
      });
    }
  }

  if (skippedCount > 0) {
    console.log(`Skipped ${skippedCount} thread summaries due to per-digest cap.`);
  }

  return { threads: summarizedThreads, skippedCount };
}

// Kept in sync with backfill-inbox-delta.js's SELECT_FIELDS -- a delta
// session only ever returns the fields requested on the call that
// established it, so both entry points must request the same set.
const INBOX_SELECT_FIELDS = 'id,conversationId,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,body,bodyPreview,importance,hasAttachments,internetMessageHeaders';

async function fetchInboxViaFixedWindow(token, since) {
  const url = `/users/${OWNER_EMAIL}/mailFolders/Inbox/messages`
    + `?$top=50`
    + `&$select=${INBOX_SELECT_FIELDS}`
    + `&$filter=receivedDateTime ge ${since}`
    + `&$orderby=receivedDateTime desc`;
  const result = await graph(token, url);
  return result.value || [];
}

// Delta sync (docs/PLAN-outlook-mcp-inspired-features.md, item 4). Only
// engages once backfill-inbox-delta.js has bootstrapped a cursor for this
// mailbox; until then (or if the cursor expires), this transparently falls
// back to the same fixed-window pull the digest has always used, so a
// missing/broken delta cursor degrades to today's known-good behavior
// rather than breaking the digest.
async function fetchInboxEmails(token, since) {
  const { data: deltaState, error: loadError } = await supabase
    .from('inbox_delta_state')
    .select('cursor_url, is_bootstrapped')
    .eq('owner_email', OWNER_EMAIL)
    .maybeSingle();

  if (loadError) {
    console.error('Failed to load inbox_delta_state, falling back to fixed-window pull:', loadError);
  }

  if (loadError || !deltaState?.is_bootstrapped || !deltaState.cursor_url) {
    return { emails: await fetchInboxViaFixedWindow(token, since), deltaResynced: false };
  }

  try {
    const { items, deltaLink, nextLink, pages } = await walkDeltaPages(token, deltaState.cursor_url, {
      maxPages: 10,
      startIsAbsolute: true,
    });

    const { error: updateError } = await supabase
      .from('inbox_delta_state')
      .update({ cursor_url: deltaLink || nextLink, updated_at: new Date().toISOString() })
      .eq('owner_email', OWNER_EMAIL);
    if (updateError) console.error('Failed to persist advanced delta cursor:', updateError);

    // Delta feeds surface changes (including read/flag changes on older
    // mail, and @removed entries for deleted/moved messages), not a clean
    // 24h window -- both are filtered out here rather than in the Graph
    // query, keeping the digest's scope identical to the fixed-window path.
    const changed = items.filter(item => !item['@removed']);
    const withinWindow = changed.filter(e => e.receivedDateTime && e.receivedDateTime >= since);
    withinWindow.sort((a, b) => new Date(b.receivedDateTime) - new Date(a.receivedDateTime));

    console.log(`Delta fetch: ${pages} page(s), ${items.length} changed item(s), ${withinWindow.length} within the 24h window.`);
    return { emails: withinWindow, deltaResynced: false };
  } catch (error) {
    if (error.status === 410) {
      // Graph invalidates a delta cursor after enough inactivity. This is
      // expected to be rare -- surfaced in the digest footer and digest_runs
      // metadata (not just logged) so a mailbox silently resyncing every run
      // is visible rather than quietly costing the fixed-window pull's cost
      // every day without anyone noticing.
      console.error('Delta cursor expired (410 Gone) -- resetting and falling back to a fixed-window pull this run.', error);
      const { error: resetError } = await supabase
        .from('inbox_delta_state')
        .update({
          cursor_url: null,
          is_bootstrapped: false,
          last_resync_at: new Date().toISOString(),
          last_resync_reason: 'expired_410',
        })
        .eq('owner_email', OWNER_EMAIL);
      if (resetError) console.error('Failed to reset inbox_delta_state after 410:', resetError);

      return { emails: await fetchInboxViaFixedWindow(token, since), deltaResynced: true };
    }
    throw error;
  }
}

export async function runDigest() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing Supabase environment variables: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY');
  }

  const token = await getGraphToken();

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Loaded concurrently with the inbox fetch, and -- this ordering is
  // load-bearing, not incidental -- BEFORE today's emails are saved into
  // email_messages below. If the stats load happened after that save loop,
  // today's own arrivals would count toward "prior" correspondence,
  // misclassifying a true first-time sender who sends 2-3 emails in one day
  // as a frequent contact.
  const [{ emails, deltaResynced }, correspondentStats] = await Promise.all([
    fetchInboxEmails(token, since),
    loadCorrespondentStatsMap(supabase, OWNER_EMAIL, {
      days: resolveHistoryWindowDays(),
      maxMessages: resolveHistoryMaxMessages(),
    }),
  ]);

  // SPF/DKIM/DMARC verdicts Microsoft 365 already computed on inbound mail --
  // read once here so both the spam pre-pass and the triage prompt (and the
  // deterministic banner below) can use them without re-parsing headers.
  const authResultsByEmailId = new Map(
    emails.map(e => [e.id, parseAuthResults(e.internetMessageHeaders)])
  );

  const savedEmails = [];
  const savedThreads = [];

  for (const email of emails) {
    const saved = await saveEmailToMemory(email);
    if (saved) {
      savedEmails.push(saved);
      const savedThread = await upsertThreadMemory(supabase, OWNER_EMAIL, email);
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
      status: 'no_emails',
      metadata: { delta_resynced: deltaResynced }
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

  const spamCheckList = emails.map((e, i) => {
    const auth = authResultsByEmailId.get(e.id) || {};
    const authNote = (auth.spf || auth.dmarc)
      ? ` | Auth: spf=${auth.spf || 'n/a'},dkim=${auth.dkim || 'n/a'},dmarc=${auth.dmarc || 'n/a'}`
      : '';
    return `${i}|${e.id}|From: ${e.from?.emailAddress?.name} <${e.from?.emailAddress?.address}> | Subject: ${e.subject} | Preview: ${e.bodyPreview?.slice(0, 100)}${authNote}`;
  }).join('\n');

  const spamResponse = await callClaude({
    maxTokens: 500,
    system: `You are a spam filter for Grant Carlson's business email at Milestone Properties, a property management company.

Return ONLY a JSON array of index numbers (0-based) for emails that are CLEARLY spam or mass solicitation — things like:
- Cold sales outreach with no prior relationship
- Mass marketing emails / newsletters Grant didn't sign up for
- SEO, web design, or digital marketing solicitations
- Phishing attempts or scammy offers
- Generic "we can help your business" cold pitches
- An "Auth: spf=fail" or "dmarc=fail" tag combined with a request to change payment, banking, or wire details — this is a strong spoofing signal even when the display name looks like a known contact or vendor

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
  let archiveFailedCount = 0;
  let filteredSpamCount = 0;
  let filteredEmails = emails;
  try {
    const spamIndices = JSON.parse(spamResponse.content[0].text.trim());
    if (Array.isArray(spamIndices) && spamIndices.length > 0) {
      filteredSpamCount = spamIndices.filter(i => emails[i]).length;
      if (process.env.AUTO_ARCHIVE_SPAM === 'true') {
        const archivePromises = spamIndices
          .filter(i => emails[i])
          .map(i => archiveEmail(token, emails[i].id));
        const results = await Promise.all(archivePromises);
        archivedCount = results.filter(r => r.ok).length;
        archiveFailedCount = results.filter(r => !r.ok).length;
      }
      const spamSet = new Set(spamIndices);
      filteredEmails = emails.filter((_, i) => !spamSet.has(i));
    }
  } catch {
    filteredEmails = emails;
  }

  if (filteredEmails.length === 0) {
    const archivedNote = archivedCount > 0
      ? ` (${archivedCount} spam emails auto-archived${archiveFailedCount > 0 ? `, ${archiveFailedCount} failed to archive` : ''})`
      : filteredSpamCount > 0
        ? ` (${filteredSpamCount} suspected spam/noise emails filtered but not archived)`
        : '';
    const digestTs = await slackPost(`*Morning Digest* — No actionable emails in the last 24 hours.${archivedNote} ✅`);
    await updateDigestRun(digestRun?.id, {
      slack_thread_ts: digestTs || null,
      run_completed_at: new Date().toISOString(),
      included_count: 0,
      actionable_count: 0,
      archived_count: archivedCount,
      status: 'no_actionable',
      metadata: {
        filtered_spam_count: filteredSpamCount,
        archive_failed_count: archiveFailedCount,
        auto_archive_spam: process.env.AUTO_ARCHIVE_SPAM === 'true',
        delta_resynced: deltaResynced
      }
    });
    return;
  }

  const { threads: summarizedThreads, skippedCount: skippedThreadCount } = await summarizeThreadMemories(filteredEmails);
  console.log(`Summarized ${summarizedThreads.length} thread memories.`);

  const { entities: savedEntities, skippedCount: skippedEntityCount } = await extractEntitiesFromEmails(filteredEmails);
  console.log(`Saved ${savedEntities.length} entity mentions.`);

  const savedDigestItems = await saveDigestItems(digestRun?.id, filteredEmails);
  console.log(`Saved ${savedDigestItems.length}/${filteredEmails.length} digest item mappings.`);

  const historyWindowDays = resolveHistoryWindowDays();
  let historyEnrichedCount = 0;

  const emailList = filteredEmails.map((e, i) => {
    const received = new Date(e.receivedDateTime);
    const daysAgo = Math.floor((today - received) / (1000 * 60 * 60 * 24));
    const ageNote = daysAgo > 0 ? ` (${daysAgo}d ago)` : ' (today)';
    const auth = authResultsByEmailId.get(e.id) || {};
    const authNote = isAuthFailure(auth) ? ` | ⚠️ AUTH FAILED (spf=${auth.spf || 'n/a'}, dmarc=${auth.dmarc || 'n/a'})` : '';

    const stats = correspondentStats.get(normalizeEmail(e.from?.emailAddress?.address));
    let historyNote = '';
    if (qualifiesForHistoryNote(stats)) {
      historyEnrichedCount += 1;
      const subjectNote = stats.last_subject ? `, most recent: "${stats.last_subject}"` : '';
      historyNote = ` | History: ${stats.inbound_count + stats.outbound_count} prior exchanges `
        + `(${stats.inbound_count} received, ${stats.outbound_count} sent) in the last ${historyWindowDays}d${subjectNote}`;
      console.log(`Correspondent history note for ${e.from?.emailAddress?.address}:${historyNote}`);
    }

    return `${i + 1}. From: ${e.from?.emailAddress?.name || e.from?.emailAddress?.address} <${e.from?.emailAddress?.address}> | Subject: ${e.subject} | Read: ${e.isRead}${ageNote} | Preview: ${e.bodyPreview?.slice(0, 150)}${authNote}${historyNote}`;
  }).join('\n');

  // Deterministic check, not model judgment: flag anything that failed sender
  // authentication AND asks to change how/where money moves. This is exactly
  // the case the spam-filter prompt is told NOT to flag as spam (invoices
  // from known/unknown vendors are protected there), so it needs a separate
  // guarantee that doesn't depend on the model getting it right.
  const authFlaggedEmails = filteredEmails
    .map((e, i) => ({ email: e, number: i + 1, auth: authResultsByEmailId.get(e.id) || {} }))
    .filter(({ email, auth }) =>
      isAuthFailure(auth) && looksLikePaymentRequest(`${email.subject} ${email.bodyPreview}`)
    );

  const response = await callClaude({
    maxTokens: 2000,
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

AUTHENTICATION FAILURES:
- If a line is tagged "⚠️ AUTH FAILED", it failed the sender's own SPF/DMARC check — treat this as a real spoofing signal, not a formality, even if the sender name looks familiar
- Put these in 🔴 Action Required with a note to verify the sender out-of-band before doing anything the email asks
- Do not let a familiar display name override this — that's exactly what a spoofed sender name is designed to exploit

CATEGORIZATION:
- 🔧 System Alerts: Automation errors, Zapier failures, system notifications that indicate something broke
- 🔴 Action Required: Emails that genuinely need Grant to do something — reply, sign, approve, pay, decide
- 🟡 FYI / Needs Awareness: Emails Grant should know about but don't require action yet — reports, forwarded info, colleague updates
- Low Priority / Noise emails (automated confirmations, newsletters, routine system reports, daily delinquency reports that ran fine, Adobe Acrobat comment notifications, AppFolio automated confirmations) — SILENTLY DISCARD. Do not include them in any section.

NUMBERING:
- Assign each email a number [#N] in Action Required items only
- Don't number FYI items

CORRESPONDENCE HISTORY:
- If a line includes a "History:" note, use it to make that item's one-line summary context-aware — e.g. "4th follow-up on the BECU refi" rather than restating the subject as if this were a first contact
- Do not fabricate or imply history for lines without a "History:" note

OMIT sections with no emails entirely.${triageRulesSection}`,
    messages: [{
      role: 'user',
      content: `Here are Grant's emails from the last 24 hours. Please triage them:\n\n${emailList}`,
    }],
  });

  let digest = response.content[0].text;

  if (authFlaggedEmails.length > 0) {
    const banner = authFlaggedEmails.map(({ email, number, auth }) => {
      const sender = email.from?.emailAddress || {};
      return `• [#${number}] ${sender.name || sender.address} <${sender.address}> — "${email.subject}" — spf=${auth.spf || 'n/a'}, dmarc=${auth.dmarc || 'n/a'}`;
    }).join('\n');
    digest = `*🚨 AUTHENTICATION FAILURE DETECTED — possible phishing/fraud*\n`
      + `_Failed sender authentication AND mentions payment/banking/wire details. This is a deterministic check, not a model judgment call — verify independently (call the sender at a known number) before acting on anything these emails ask for._\n`
      + `${banner}\n\n${digest}`;
  }

  if (archivedCount > 0) {
    digest += `\n_🗑️ ${archivedCount} spam email${archivedCount > 1 ? 's' : ''} auto-archived_`;
  } else if (filteredSpamCount > 0) {
    digest += `\n_🧹 ${filteredSpamCount} suspected spam/noise email${filteredSpamCount > 1 ? 's' : ''} filtered from this digest; not archived_`;
  }

  if (archiveFailedCount > 0) {
    digest += `\n_⚠️ ${archiveFailedCount} spam email${archiveFailedCount > 1 ? 's' : ''} failed to archive — still in Inbox_`;
  }

  const capNotes = [];
  if (skippedThreadCount > 0) capNotes.push(`${skippedThreadCount} thread${skippedThreadCount > 1 ? 's' : ''} not summarized`);
  if (skippedEntityCount > 0) capNotes.push(`${skippedEntityCount} email${skippedEntityCount > 1 ? 's' : ''} not scanned for entities`);
  if (capNotes.length > 0) {
    digest += `\n_⚠️ Volume cap hit today: ${capNotes.join(', ')} due to per-digest limits. These weren't added to memory today — the maintenance rotation covers this task roughly once every 10 days, so run it manually (\`/api/memory-maintenance?task=operational_memory\` or \`?task=entities\`) if you want it sooner._`;
  }

  if (deltaResynced) {
    digest += `\n_🔄 Delta sync cursor expired and was reset — this run used a full pull instead. Re-run \`/api/backfill-inbox-delta\` when convenient to re-establish it._`;
  }

  // One ✍️ Reply button per numbered Action Required item. buildDigestBlocks
  // returns null when nothing is numbered, in which case this posts exactly
  // the plain text it always did.
  const digestItemNumbers = extractDigestItemNumbers(digest);
  const digestTs = await slackPost(digest, null, buildDigestBlocks(digest, digestItemNumbers));
  await updateDigestRun(digestRun?.id, {
    slack_thread_ts: digestTs || null,
    run_completed_at: new Date().toISOString(),
    included_count: filteredEmails.length,
    archived_count: archivedCount,
    status: 'posted',
    metadata: {
      filtered_spam_count: filteredSpamCount,
      archive_failed_count: archiveFailedCount,
      auto_archive_spam: process.env.AUTO_ARCHIVE_SPAM === 'true',
      skipped_thread_summaries: skippedThreadCount,
      skipped_entity_extractions: skippedEntityCount,
      auth_flagged_count: authFlaggedEmails.length,
      history_enriched_count: historyEnrichedCount,
      delta_resynced: deltaResynced
    }
  });

  await slackPost(
    '_Hit ✍️ Reply on any numbered item above to start a response, or reply here — e.g. "what does #3 say", "mark #2 as done"_',
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
