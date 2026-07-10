import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const CHANNEL_ID = 'C0AS84GA607'; // #inbox-digest
const OWNER_EMAIL = 'grant@milestoneproperties.net';
const TIME_ZONE = 'America/Los_Angeles';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export const config = {
  maxDuration: 60,
};

function verifyCronRequest(req) {
  return req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
}

function projectRefFromUrl() {
  try {
    return new URL(process.env.SUPABASE_URL).hostname.split('.')[0] || null;
  } catch {
    return null;
  }
}

function localDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    date: `${lookup.year}-${lookup.month}-${lookup.day}`,
    weekday: lookup.weekday,
  };
}

function isWeekday(weekday) {
  return !['Sat', 'Sun'].includes(weekday);
}

function boundedInteger(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function parseJsonObject(text) {
  const normalizedText = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(normalizedText);
  } catch {}

  const match = normalizedText.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function isMissingTableError(error) {
  return error?.code === '42P01'
    || error?.code === 'PGRST205'
    || /could not find the table|relation .* does not exist/i.test(error?.message || '');
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function truncate(value, max = 1200) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function sourceSystemFromValue(value) {
  const text = String(value || '').toLowerCase();
  if (!text) return null;
  if (text.includes('appfolio')) return 'appfolio';
  if (text.includes('whatsapp')) return 'whatsapp';
  if (text.includes('slack') || text.includes('digest')) return 'slack';
  if (text.includes('github')) return 'github';
  if (text.includes('vercel')) return 'vercel';
  if (
    text.includes('email')
    || text.includes('outlook')
    || text.includes('graph')
    || text.includes('message')
    || text.includes('thread')
  ) {
    return 'email';
  }
  return 'supabase_memory';
}

function sourceTruthRole(sourceSystem) {
  const roles = {
    appfolio: 'current property, tenant, accounting, and ledger status',
    email: 'conversation history, requests, promises, and attachments',
    whatsapp: 'informal work conversation history',
    slack: 'team communication, approvals, and bot workflow state',
    supabase_memory: 'assistant memory, summaries, open loops, commitments, and context cards',
    github: 'code and repository history',
    vercel: 'deployed app and runtime configuration state',
  };
  return roles[sourceSystem] || 'supporting memory';
}

function fallbackCardFromChunk(item) {
  return {
    card_type: item.source_type,
    title: item.title,
    summary: item.chunk_summary || item.chunk_text,
    importance: 'normal',
    facts: item.metadata || {},
    source_system: sourceSystemFromValue(item.source_table || item.source_type),
  };
}

async function loadChunkFallback(memoryLimit) {
  const [sourceMemory, ownerMemory] = await Promise.all([
    supabase
      .from('memory_chunks')
      .select('id, source_type, source_table, source_pk, title, chunk_summary, chunk_text, metadata, updated_at')
      .eq('owner_email', OWNER_EMAIL)
      .in('source_type', ['property_profile', 'team_member', 'agent_context', 'real_estate_schedule'])
      .order('updated_at', { ascending: false })
      .limit(memoryLimit),
    supabase
      .from('memory_chunks')
      .select('id, source_type, source_table, source_pk, title, chunk_summary, chunk_text, metadata, updated_at')
      .eq('owner_email', OWNER_EMAIL)
      .eq('source_type', 'owner_investor')
      .order('updated_at', { ascending: false })
      .limit(30),
  ]);

  const errors = [sourceMemory.error, ownerMemory.error].filter(Boolean);
  if (errors.length) throw new Error(`Priority chunk fallback load failed: ${errors[0].message}`);

  return [...(sourceMemory.data || []), ...(ownerMemory.data || [])].map(fallbackCardFromChunk);
}

async function loadPriorityContext({ emailLimit, memoryLimit }) {
  const [
    openLoops,
    commitments,
    draftCandidates,
    digestItems,
    recentEmails,
    contextCards,
    operationalProjects,
  ] = await Promise.all([
    supabase
      .from('open_loops')
      .select('id, title, description, priority, due_at, status, metadata, updated_at')
      .eq('owner_email', OWNER_EMAIL)
      .in('status', ['open', 'waiting'])
      .order('updated_at', { ascending: false })
      .limit(20),
    supabase
      .from('commitments')
      .select('id, title, commitment, owner_name, due_at, status, metadata, updated_at')
      .eq('owner_email', OWNER_EMAIL)
      .in('status', ['open', 'waiting'])
      .order('updated_at', { ascending: false })
      .limit(20),
    supabase
      .from('draft_response_candidates')
      .select('id, sender_email, sender_name, subject, received_at, reason, context_summary, known_contact_score, back_and_forth_thread_count')
      .eq('owner_email', OWNER_EMAIL)
      .eq('status', 'candidate')
      .order('received_at', { ascending: false })
      .limit(12),
    supabase
      .from('digest_items')
      .select('item_number, sender_name, sender_email, subject, received_at, classification, action_status, raw_digest_input, created_at')
      .in('action_status', ['open', 'waiting'])
      .order('created_at', { ascending: false })
      .limit(20),
    supabase
      .from('email_messages')
      .select('graph_message_id, graph_conversation_id, subject, sender_name, sender_email, received_at, importance, body_preview, has_attachments')
      .eq('owner_email', OWNER_EMAIL)
      .eq('folder', 'Inbox')
      .order('received_at', { ascending: false })
      .limit(emailLimit),
    supabase
      .from('context_cards')
      .select('id, card_type, card_key, title, summary, facts, status, importance, last_seen_at, source_updated_at, updated_at')
      .eq('owner_email', OWNER_EMAIL)
      .eq('status', 'active')
      .in('card_type', ['property', 'investment_profile', 'owner_investor', 'team_member', 'operating_context', 'project', 'open_loop', 'commitment', 'organization'])
      .order('updated_at', { ascending: false })
      .limit(memoryLimit),
    supabase
      .from('memory_projects')
      .select('id, name, status, summary, metadata, last_seen_at')
      .eq('owner_email', OWNER_EMAIL)
      .in('status', ['active', 'waiting', 'stale'])
      .order('last_seen_at', { ascending: false })
      .limit(15),
  ]);

  const errors = [
    openLoops.error,
    commitments.error,
    draftCandidates.error,
    digestItems.error,
    recentEmails.error,
    operationalProjects.error,
  ].filter(Boolean);
  if (errors.length) throw new Error(`Priority context load failed: ${errors[0].message}`);

  let cardRows = contextCards.data || [];
  let contextCardMode = 'context_cards';
  if (contextCards.error) {
    if (!isMissingTableError(contextCards.error)) {
      throw new Error(`Priority context card load failed: ${contextCards.error.message}`);
    }
    cardRows = await loadChunkFallback(memoryLimit);
    contextCardMode = 'chunk_fallback';
  }

  return {
    open_loops: openLoops.data || [],
    commitments: commitments.data || [],
    draft_candidates: draftCandidates.data || [],
    digest_items: digestItems.data || [],
    recent_emails: recentEmails.data || [],
    context_cards: cardRows,
    context_card_mode: contextCardMode,
    operational_projects: operationalProjects.data || [],
  };
}

function compactContext(context) {
  return {
    open_loops: context.open_loops.map(item => ({
      title: item.title,
      description: truncate(item.description, 500),
      priority: item.priority,
      due_at: item.due_at,
      status: item.status,
      source_subject: item.metadata?.source_subject || null,
      source_system: 'supabase_memory',
    })),
    commitments: context.commitments.map(item => ({
      title: item.title,
      commitment: truncate(item.commitment, 500),
      owner_name: item.owner_name,
      due_at: item.due_at,
      status: item.status,
      source_subject: item.metadata?.source_subject || null,
      source_system: 'supabase_memory',
    })),
    draft_candidates: context.draft_candidates.map(item => ({
      sender: item.sender_name || item.sender_email,
      subject: item.subject,
      received_at: item.received_at,
      reason: item.reason,
      preview: truncate(item.context_summary, 450),
      known_contact_score: item.known_contact_score,
      source_system: 'email',
    })),
    digest_items: context.digest_items.map(item => ({
      item_number: item.item_number,
      sender: item.sender_name || item.sender_email,
      subject: item.subject,
      received_at: item.received_at,
      classification: item.classification,
      action_status: item.action_status,
      preview: truncate(item.raw_digest_input?.body_preview || item.raw_digest_input?.preview, 350),
      source_system: 'slack',
    })),
    recent_emails: context.recent_emails.map(item => ({
      sender: item.sender_name || item.sender_email,
      subject: item.subject,
      received_at: item.received_at,
      importance: item.importance,
      has_attachments: item.has_attachments,
      preview: truncate(item.body_preview, 350),
      source_system: 'email',
    })),
    context_cards: context.context_cards.map(item => ({
      card_type: item.card_type,
      title: item.title,
      summary: truncate(item.summary, 550),
      importance: item.importance,
      facts: item.facts,
      source_system: item.source_system || sourceSystemFromValue(item.card_type),
      source_truth_role: sourceTruthRole(item.source_system || sourceSystemFromValue(item.card_type)),
    })),
    operational_projects: context.operational_projects.map(item => ({
      name: item.name,
      status: item.status,
      summary: truncate(item.summary, 550),
      source_subject: item.metadata?.source_subject || null,
      source_system: 'supabase_memory',
    })),
    context_card_mode: context.context_card_mode,
  };
}

async function generatePrioritySuggestion(context, suggestionDate) {
  const compact = compactContext(context);
  const response = await new Anthropic().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 3000,
    system: `You select Grant Carlson's weekday One Priority for Milestone Properties.

Use the focusing-question standard from The ONE Thing:
What is the ONE activity Grant can do today such that by doing it, other work becomes easier or unnecessary?

Choose one concrete activity, not a vague theme. Optimize for organization-level impact: cash, risk reduction, owner/investor/lender trust, team unblock, major property operations, or compounding process improvement.

Do not choose routine email triage unless it clearly unlocks a bigger outcome. Prefer an activity that Grant can start today. Be evidence-based and humble.`,
    messages: [{
      role: 'user',
      content: `Today is ${suggestionDate} in ${TIME_ZONE}.

Return ONLY valid JSON with this shape:
{
  "title": "short title",
  "activity": "one concrete activity Grant should do today",
  "why_this_matters": "organization-level reason",
  "first_step": "10-30 minute starting action",
  "suggested_time_block": "calendar-sized block",
  "evidence": [{"source": "email|appfolio|whatsapp|slack|supabase_memory|open_loop|commitment|digest", "label": "", "detail": ""}],
  "confidence_note": "short note on how strong the evidence is and what source of truth is missing, if any",
  "runners_up": [{"title": "", "why_not_chosen": ""}],
  "scoring": {"impact": 1, "urgency": 1, "leverage": 1, "relationship_importance": 1, "confidence": 1, "effort_penalty": 1, "total": 1}
}

Context:
${JSON.stringify(compact, null, 2)}`,
    }],
  });

  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim();
  const parsed = parseJsonObject(text);
  if (!parsed) throw new Error(`Priority model returned non-JSON output: ${text.slice(0, 500)}`);
  return parsed;
}

function formatSlackMessage(suggestion, suggestionDate) {
  const confidence = suggestion.scoring?.confidence
    ? `*Confidence:* ${suggestion.scoring.confidence}/5`
    : null;
  return [
    `*One Priority* (${suggestionDate})`,
    `*${truncate(suggestion.title || 'Highest-leverage activity', 80)}*`,
    truncate(suggestion.activity, 220),
    suggestion.first_step ? `*Start:* ${truncate(suggestion.first_step, 140)}` : null,
    `*Block:* ${truncate(suggestion.suggested_time_block || '60-90 minutes', 60)}`,
    confidence,
  ].filter(Boolean).join('\n');
}

async function slackPost(text) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel: CHANNEL_ID,
      text,
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack post failed: ${data.error}`);
  return data.ts;
}

async function saveSuggestion({ suggestion, suggestionDate, slackTs = null, rawContextCounts }) {
  const { data, error } = await supabase
    .from('daily_priority_suggestions')
    .upsert({
      owner_email: OWNER_EMAIL,
      suggestion_date: suggestionDate,
      status: 'suggested',
      title: suggestion.title || 'Daily One Priority',
      activity: suggestion.activity || '',
      why_this_matters: suggestion.why_this_matters || null,
      first_step: suggestion.first_step || null,
      suggested_time_block: suggestion.suggested_time_block || null,
      evidence: safeArray(suggestion.evidence),
      runners_up: safeArray(suggestion.runners_up),
      scoring: suggestion.scoring || {},
      raw_model_output: {
        suggestion,
        confidence_note: suggestion.confidence_note || null,
        context_counts: rawContextCounts,
      },
      slack_channel_id: slackTs ? CHANNEL_ID : null,
      slack_message_ts: slackTs,
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'owner_email,suggestion_date',
    })
    .select()
    .single();

  if (error) throw new Error(`Daily priority save failed: ${error.message}`);
  return data;
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).end();
  if (!verifyCronRequest(req)) return res.status(401).json({ error: 'Unauthorized' });

  const local = localDateParts();
  if (!isWeekday(local.weekday) && req.query.force !== '1') {
    return res.status(200).json({
      ok: true,
      skipped: true,
      reason: 'weekend',
      suggestion_date: local.date,
      weekday: local.weekday,
    });
  }

  try {
    const emailLimit = boundedInteger(req.query.emails, 35, 100);
    const memoryLimit = boundedInteger(req.query.memory, 80, 200);
    const shouldPost = req.query.post !== '0' && req.query.dry_run !== '1';
    const suggestionDate = req.query.date || local.date;

    const context = await loadPriorityContext({ emailLimit, memoryLimit });
    const suggestion = await generatePrioritySuggestion(context, suggestionDate);
    const rawContextCounts = Object.fromEntries(
      Object.entries(context).map(([key, value]) => [key, Array.isArray(value) ? value.length : 0])
    );

    const slackText = formatSlackMessage(suggestion, suggestionDate);
    const slackTs = shouldPost ? await slackPost(slackText) : null;
    const saved = req.query.dry_run === '1'
      ? null
      : await saveSuggestion({ suggestion, suggestionDate, slackTs, rawContextCounts });

    return res.status(200).json({
      ok: true,
      supabase_project_ref: projectRefFromUrl(),
      suggestion_date: suggestionDate,
      weekday: local.weekday,
      posted_to_slack: Boolean(slackTs),
      slack_ts: slackTs,
      saved_id: saved?.id || null,
      context_counts: rawContextCounts,
      suggestion,
      slack_preview: slackText,
    });
  } catch (error) {
    console.error('Weekday one priority failed:', error);
    return res.status(500).json({
      ok: false,
      supabase_project_ref: projectRefFromUrl(),
      error: error.message,
    });
  }
}
