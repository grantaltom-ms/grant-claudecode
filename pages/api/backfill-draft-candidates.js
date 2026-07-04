import { createClient } from '@supabase/supabase-js';

const OWNER_EMAIL = 'grant@milestoneproperties.net';
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

function normalizeEmail(value) {
  return (value || '').trim().toLowerCase();
}

function recipientAddresses(message) {
  return [...(message.recipients || []), ...(message.cc_recipients || [])]
    .map(recipient => normalizeEmail(recipient?.emailAddress?.address || recipient?.address))
    .filter(Boolean);
}

function isExternalContact(email) {
  const normalized = normalizeEmail(email);
  return normalized && normalized !== OWNER_EMAIL && !normalized.endsWith('@milestoneproperties.net');
}

function buildContactStats(messages) {
  const stats = new Map();

  function ensure(email) {
    const normalized = normalizeEmail(email);
    if (!stats.has(normalized)) {
      stats.set(normalized, {
        email: normalized,
        inbound_count: 0,
        outbound_count: 0,
        conversations: new Map(),
      });
    }
    return stats.get(normalized);
  }

  function markConversation(contactStats, conversationId, direction) {
    if (!conversationId) return;
    const current = contactStats.conversations.get(conversationId) || { inbound: 0, outbound: 0 };
    current[direction] += 1;
    contactStats.conversations.set(conversationId, current);
  }

  for (const message of messages) {
    const folder = message.folder;
    const conversationId = message.graph_conversation_id || message.graph_message_id;

    if (folder === 'Inbox' && isExternalContact(message.sender_email)) {
      const contactStats = ensure(message.sender_email);
      contactStats.inbound_count += 1;
      markConversation(contactStats, conversationId, 'inbound');
    }

    if (folder === 'SentItems') {
      for (const recipient of recipientAddresses(message)) {
        if (!isExternalContact(recipient)) continue;
        const contactStats = ensure(recipient);
        contactStats.outbound_count += 1;
        markConversation(contactStats, conversationId, 'outbound');
      }
    }
  }

  for (const contactStats of stats.values()) {
    contactStats.back_and_forth_thread_count = [...contactStats.conversations.values()]
      .filter(conversation => conversation.inbound > 0 && conversation.outbound > 0)
      .length;
    contactStats.known_contact_score =
      contactStats.back_and_forth_thread_count * 10
      + Math.min(contactStats.inbound_count, 10)
      + Math.min(contactStats.outbound_count, 10);
  }

  return stats;
}

function qualifies(stats) {
  if (!stats) return false;
  return stats.back_and_forth_thread_count >= 2;
}

const RESPONSE_REQUEST_PATTERNS = [
  { label: 'question_mark', pattern: /\?/ },
  { label: 'direct_question', pattern: /\b(can|could|would|will|do|did|are|is|should)\s+(you|we|i)\b/ },
  { label: 'please', pattern: /\bplease\b/ },
  { label: 'let_me_know', pattern: /\blet me know\b/ },
  { label: 'confirm', pattern: /\bconfirm\b/ },
  { label: 'review', pattern: /\breview\b/ },
  { label: 'approve', pattern: /\bapprove\b/ },
  { label: 'send_request', pattern: /\b(send|provide|share)\s+(me|us|over|the|a|an|any|updated|current)\b/ },
  { label: 'need_from_you', pattern: /\bneed\s+(you|your|from you|to know|approval|confirmation|input|direction)\b/ },
  { label: 'waiting', pattern: /\bwaiting\b/ },
  { label: 'following_up', pattern: /\bfollow(?:ing)? up\b/ },
  { label: 'thoughts', pattern: /\bthoughts\b/ },
  { label: 'availability', pattern: /\bavailable\b/ },
  { label: 'direction_or_decision', pattern: /\b(direction|decision)\b/ },
  { label: 'next_step', pattern: /\bnext step\b/ },
];

const NON_RESPONSE_PATTERNS = [
  { label: 'no_action_required', pattern: /\bno (action|response) required\b/ },
  { label: 'does_not_require_response', pattern: /\bdoes not require (a )?response\b/ },
  { label: 'for_your_records', pattern: /\bfor your records\b/ },
  { label: 'for_awareness', pattern: /\bfor awareness\b/ },
  { label: 'just_letting_you_know', pattern: /\bjust (letting|wanted to let) you know\b/ },
  { label: 'fyi', pattern: /\bfyi\b/ },
  { label: 'receipt', pattern: /\breceipt\b/ },
  { label: 'automated_notification', pattern: /\bauto(?:mated)? notification\b/ },
  { label: 'daily_report', pattern: /\bdaily delinquency report\b/ },
  { label: 'weekly_report', pattern: /\bweekly report\b/ },
  { label: 'monthly_statement', pattern: /\bmonthly statement\b/ },
  { label: 'newsletter', pattern: /\bnewsletter\b/ },
  { label: 'statement_available', pattern: /\bstatement available\b/ },
  { label: 'payment_confirmation', pattern: /\bpayment confirmation\b/ },
];

function textForIntent(message) {
  return [
    message.subject,
    message.body_preview,
    message.body_text,
  ].filter(Boolean).join('\n').toLowerCase();
}

function seemsToNeedResponse(message) {
  const sender = normalizeEmail(message.sender_email);
  const text = textForIntent(message);
  const matchedNonResponse = NON_RESPONSE_PATTERNS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ label }) => label);
  const matchedRequest = RESPONSE_REQUEST_PATTERNS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ label }) => label);

  if (sender.includes('no-reply') || sender.includes('noreply')) {
    return {
      seeks_response: false,
      matched_request_terms: matchedRequest,
      matched_non_response_terms: ['noreply_sender', ...matchedNonResponse],
    };
  }

  if (matchedNonResponse.length && !matchedRequest.length) {
    return {
      seeks_response: false,
      matched_request_terms: matchedRequest,
      matched_non_response_terms: matchedNonResponse,
    };
  }

  return {
    seeks_response: matchedRequest.length > 0,
    matched_request_terms: matchedRequest,
    matched_non_response_terms: matchedNonResponse,
  };
}

async function loadContactHistory(days, maxMessages) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('email_messages')
    .select('id, graph_message_id, graph_conversation_id, folder, sender_email, recipients, cc_recipients, received_at, sent_at')
    .eq('owner_email', OWNER_EMAIL)
    .or(`received_at.gte.${since},sent_at.gte.${since}`)
    .order('received_at', { ascending: false, nullsFirst: false })
    .limit(maxMessages);

  if (error) throw new Error(`Contact history load failed: ${error.message}`);
  return data || [];
}

async function loadRecentInbound(days, maxMessages) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('email_messages')
    .select('id, graph_message_id, graph_conversation_id, subject, sender_name, sender_email, received_at, body_preview, body_text, is_read')
    .eq('owner_email', OWNER_EMAIL)
    .eq('folder', 'Inbox')
    .gte('received_at', since)
    .order('received_at', { ascending: false })
    .limit(maxMessages);

  if (error) throw new Error(`Recent inbound load failed: ${error.message}`);
  return data || [];
}

async function refreshCandidateWindow(days) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase
    .from('draft_response_candidates')
    .delete()
    .eq('owner_email', OWNER_EMAIL)
    .eq('status', 'candidate')
    .gte('received_at', since);

  if (error) throw new Error(`Candidate refresh failed: ${error.message}`);
}

async function existingCandidateIds(messageIds) {
  if (!messageIds.length) return new Set();
  const { data, error } = await supabase
    .from('draft_response_candidates')
    .select('graph_message_id')
    .eq('owner_email', OWNER_EMAIL)
    .in('graph_message_id', messageIds);

  if (error) throw new Error(`Existing candidate lookup failed: ${error.message}`);
  return new Set((data || []).map(row => row.graph_message_id));
}

async function upsertCandidate(message, stats, responseIntent) {
  const reason = [
    `Known contact: ${stats.back_and_forth_thread_count} prior back-and-forth thread(s), ${stats.inbound_count} inbound, ${stats.outbound_count} outbound.`,
    `Response intent: ${responseIntent.matched_request_terms.slice(0, 3).join(', ') || 'request-like language detected'}.`,
  ].join(' ');
  const { data, error } = await supabase
    .from('draft_response_candidates')
    .upsert({
      owner_email: OWNER_EMAIL,
      status: 'candidate',
      graph_message_id: message.graph_message_id,
      graph_conversation_id: message.graph_conversation_id || null,
      message_id: message.id,
      sender_email: normalizeEmail(message.sender_email),
      sender_name: message.sender_name || null,
      subject: message.subject || null,
      received_at: message.received_at || null,
      known_contact_score: stats.known_contact_score,
      inbound_count: stats.inbound_count,
      outbound_count: stats.outbound_count,
      back_and_forth_thread_count: stats.back_and_forth_thread_count,
      reason,
      context_summary: message.body_preview || null,
      metadata: {
        is_read: message.is_read,
        gate: 'requires_two_prior_back_and_forth_threads_and_response_intent',
        response_intent: responseIntent,
      },
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'owner_email,graph_message_id',
    })
    .select()
    .single();

  if (error) throw new Error(`Candidate upsert failed: ${error.message}`);
  return data;
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).end();
  if (!verifyCronRequest(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const candidateDays = boundedInteger(req.query.days, 14, 60);
    const historyDays = boundedInteger(req.query.history_days, 365, 730);
    const maxCandidates = boundedInteger(req.query.max, 50, 200);
    const maxHistory = boundedInteger(req.query.history_max, 2000, 5000);
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';

    if (refresh) {
      await refreshCandidateWindow(candidateDays);
    }

    const [history, inboundMessages] = await Promise.all([
      loadContactHistory(historyDays, maxHistory),
      loadRecentInbound(candidateDays, maxCandidates),
    ]);
    const stats = buildContactStats(history);
    const existingIds = await existingCandidateIds(inboundMessages.map(message => message.graph_message_id));
    const seenConversationIds = new Set();

    let considered = 0;
    let qualified = 0;
    let saved = 0;
    const skipped = {
      existing: 0,
      internal_or_unknown: 0,
      duplicate_thread: 0,
      insufficient_back_and_forth: 0,
      does_not_seek_response: 0,
    };
    const candidates = [];

    for (const message of inboundMessages) {
      considered += 1;
      const sender = normalizeEmail(message.sender_email);
      if (existingIds.has(message.graph_message_id)) {
        skipped.existing += 1;
        continue;
      }
      if (!isExternalContact(sender)) {
        skipped.internal_or_unknown += 1;
        continue;
      }

      const conversationKey = message.graph_conversation_id || message.graph_message_id;
      if (seenConversationIds.has(conversationKey)) {
        skipped.duplicate_thread += 1;
        continue;
      }
      seenConversationIds.add(conversationKey);

      const contactStats = stats.get(sender);
      if (!qualifies(contactStats)) {
        skipped.insufficient_back_and_forth += 1;
        continue;
      }

      const responseIntent = seemsToNeedResponse(message);
      if (!responseIntent.seeks_response) {
        skipped.does_not_seek_response += 1;
        continue;
      }

      qualified += 1;
      const candidate = await upsertCandidate(message, contactStats, responseIntent);
      saved += 1;
      candidates.push({
        id: candidate.id,
        sender_email: candidate.sender_email,
        subject: candidate.subject,
        received_at: candidate.received_at,
        reason: candidate.reason,
      });
    }

    return res.status(200).json({
      ok: true,
      supabase_project_ref: projectRefFromUrl(),
      candidate_days: candidateDays,
      history_days: historyDays,
      refreshed_candidate_window: refresh,
      history_messages: history.length,
      inbound_messages: inboundMessages.length,
      considered,
      qualified,
      saved_candidates: saved,
      skipped,
      candidates: candidates.slice(0, 20),
    });
  } catch (error) {
    console.error('Draft candidate backfill failed:', error);
    return res.status(500).json({
      ok: false,
      supabase_project_ref: projectRefFromUrl(),
      error: error.message,
    });
  }
}
