import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { waitUntil } from '@vercel/functions';

// Disable Next.js body parsing — need raw body for Slack signature verification
export const config = { api: { bodyParser: false } };

const CHANNEL_ID = 'C0AS84GA607'; // #inbox-digest
const OWNER_EMAIL = 'grant@milestoneproperties.net';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// --- Microsoft Graph helpers ---

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

  // 202 Accepted = success with no body (e.g. send)
  if (res.status === 202 || res.status === 204) return { success: true };

  const text = await res.text();
  if (!text) return { success: true };

  const json = JSON.parse(text);
  if (json.error) throw new Error(`Graph error: ${json.error.message}`);
  return json;
}

// --- Claude tool definitions ---

const EMAIL_TOOLS = [
  {
    name: 'list_emails',
    description: "List recent emails from Grant's inbox or a specific folder.",
    input_schema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: "Folder name: 'Inbox', 'SentItems', 'Drafts'. Default: Inbox." },
        top: { type: 'number', description: 'How many to return (max 25). Default: 15.' },
        unread_only: { type: 'boolean', description: 'If true, only return unread emails.' },
      },
    },
  },
  {
    name: 'search_emails',
    description: 'Search emails by keyword across subject, body, and sender.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms (e.g. "BECU financial documents")' },
        top: { type: 'number', description: 'Number of results. Default: 10.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_email',
    description: 'Get the full body and details of a specific email by ID.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The email message ID.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'resolve_digest_item',
    description: 'Resolve a numbered item from the current Slack digest thread, such as #1 or #3, to the real Outlook message ID and saved email metadata. Use this before acting on any numbered digest item.',
    input_schema: {
      type: 'object',
      properties: {
        item_number: { type: 'number', description: 'The digest item number, e.g. 1 for #1.' },
      },
      required: ['item_number'],
    },
  },
  {
    name: 'create_draft_reply',
    description: 'Create a saved draft reply to an email. Does NOT send it — Grant must approve first. CC recipients from the original email are automatically preserved — you do not need to specify them.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'ID of the email to reply to.' },
        body: { type: 'string', description: 'The plain-text reply body.' },
      },
      required: ['message_id', 'body'],
    },
  },
  {
    name: 'get_recent_drafts',
    description: 'Get the most recent draft emails (useful to find what was just drafted for sending).',
    input_schema: {
      type: 'object',
      properties: {
        top: { type: 'number', description: 'Number of drafts. Default: 5.' },
      },
    },
  },
  {
    name: 'create_new_draft',
    description: 'Create a brand new draft email (not a reply) to one or more recipients. Does NOT send — Grant must approve first.',
    input_schema: {
      type: 'object',
      properties: {
        to: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of recipient email addresses.',
        },
        subject: { type: 'string', description: 'Email subject line.' },
        body: { type: 'string', description: 'Plain-text email body.' },
        cc: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional CC recipients.',
        },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'send_draft',
    description: 'Send a saved draft. Only call this after Grant explicitly approves (e.g. "send it", "looks good, send").',
    input_schema: {
      type: 'object',
      properties: {
        draft_id: { type: 'string', description: 'The draft message ID to send.' },
      },
      required: ['draft_id'],
    },
  },
  {
    name: 'update_triage_rules',
    description: "Add or remove a rule that controls how the morning digest prioritizes emails. Use when Grant says certain senders or email types should always be a specific priority. Also use to list current rules when asked.",
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'remove', 'list'],
          description: 'add a new rule, remove an existing rule, or list all current rules.',
        },
        rule: {
          type: 'string',
          description: 'Plain English rule, e.g. "Emails from Crystal Li are always Action Required" or "AppFolio automated notifications are always Low Priority". Required for add/remove.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'delete_draft',
    description: 'Delete a draft email from the Drafts folder. Use when Grant says "discard it", "delete the draft", "never mind", or similar.',
    input_schema: {
      type: 'object',
      properties: {
        draft_id: { type: 'string', description: 'The draft message ID to delete.' },
      },
      required: ['draft_id'],
    },
  },
  {
    name: 'update_digest_item_status',
    description: 'Update the action status for a numbered item in the current Slack digest thread. Use this when Grant says a digest item is done, open, waiting, drafted, or dismissed.',
    input_schema: {
      type: 'object',
      properties: {
        item_number: { type: 'number', description: 'The digest item number, e.g. 2 for #2.' },
        action_status: {
          type: 'string',
          enum: ['open', 'done', 'waiting', 'drafted', 'dismissed'],
          description: 'The new status for this digest item.',
        },
      },
      required: ['item_number', 'action_status'],
    },
  },
  {
    name: 'search_context_cards',
    description: 'Search compact durable context cards for people, properties, owner/investors, projects, operating context, commitments, and open loops. Use this before search_memory when a compact summary may answer the question.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text, e.g. "Willow Lake owner" or "BECU financial statements".' },
        card_type: {
          type: 'string',
          enum: ['property', 'investment_profile', 'owner_investor', 'team_member', 'operating_context', 'project', 'decision', 'commitment', 'open_loop', 'draft_feedback', 'organization'],
          description: 'Optional context card type filter.',
        },
        limit: { type: 'number', description: 'Maximum number of results. Default 8, max 12.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_memory',
    description: 'Hybrid search across durable memory chunks from email previews/bodies, thread summaries, entities, projects, tasks, decisions, and open loops. Use this when context cards are missing, too thin, or the user needs underlying source detail.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text, e.g. "Delmont ButterflyMX internet" or "financial statements insurance".' },
        limit: { type: 'number', description: 'Maximum number of results. Default 8, max 15.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_memory_entities',
    description: 'Search durable inbox memory entities such as properties, people, owners/investors, vendors, tenants, invoices, deadlines, insurance, financial statements, projects, and issue types.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text, e.g. "Olympic View insurance" or "BECU financial statements".' },
        entity_type: {
          type: 'string',
          enum: ['property', 'person', 'vendor', 'tenant', 'invoice', 'deadline', 'insurance', 'financial_statement', 'project', 'legal_issue', 'maintenance_issue', 'leasing_issue', 'system', 'other'],
          description: 'Optional entity type filter.',
        },
        limit: { type: 'number', description: 'Maximum number of results. Default 8, max 15.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_thread_memory',
    description: 'Search saved email thread summaries and open items. Use this for questions about the latest status, open loops, or prior conversations.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text, e.g. "Delmont open items" or "insurance renewal".' },
        limit: { type: 'number', description: 'Maximum number of results. Default 8, max 15.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_entity_context',
    description: 'Get recent mentions and related email/thread context for a saved memory entity by entity_id.',
    input_schema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'The UUID returned by search_memory_entities.' },
        limit: { type: 'number', description: 'Maximum number of recent mentions. Default 8, max 15.' },
      },
      required: ['entity_id'],
    },
  },
  {
    name: 'list_draft_response_candidates',
    description: 'List recent emails that are candidates for suggested draft replies. Candidates are limited to known contacts with more than one prior back-and-forth exchange and emails that appear to seek a response.',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['candidate', 'drafted', 'dismissed', 'sent'],
          description: 'Candidate status to list. Default: candidate.',
        },
        limit: { type: 'number', description: 'Maximum number of candidates. Default 8, max 15.' },
      },
    },
  },
  {
    name: 'list_forgotten_items',
    description: 'Find operational items Grant may be forgetting: stale open loops, waiting commitments, unresolved digest items, draft reply candidates, and active context-card signals. Use when Grant asks "what am I forgetting?", "what slipped?", "what loose ends are there?", or similar.',
    input_schema: {
      type: 'object',
      properties: {
        days_stale: { type: 'number', description: 'How many days old before an open item is considered stale. Default 7, max 60.' },
        limit: { type: 'number', description: 'Maximum total ranked items to return. Default 8, max 15.' },
      },
    },
  },
  {
    name: 'update_forgotten_item_status',
    description: 'Update feedback/status for an item returned by list_forgotten_items. Use when Grant says a forgotten item is done, dismissed, waiting, snoozed, important, open, or priority. Resolve numbered references like "#2" against the latest forgotten-items list in the current Slack thread.',
    input_schema: {
      type: 'object',
      properties: {
        rank: { type: 'number', description: '1-based item number from the latest forgotten-items list, e.g. 2 for #2.' },
        item_id: { type: 'string', description: 'Optional direct item UUID from list_forgotten_items.' },
        item_kind: { type: 'string', description: 'Optional direct item kind from list_forgotten_items, e.g. open_loop, commitment, draft_candidate, digest_item, context_project.' },
        action: {
          type: 'string',
          enum: ['done', 'dismiss', 'waiting', 'snooze', 'priority', 'open'],
          description: 'The feedback/status to apply.',
        },
        snooze_days: { type: 'number', description: 'For action=snooze, number of days to hide/deprioritize the item. Default 7, max 90.' },
        note: { type: 'string', description: 'Optional short note from Grant about why this status changed.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'resolve_draft_response_candidate',
    description: 'Resolve a draft response candidate by candidate UUID or list rank, then load its original email, thread memory, and prior draft feedback. Use this before drafting a chosen candidate such as "draft candidate #1".',
    input_schema: {
      type: 'object',
      properties: {
        candidate_id: { type: 'string', description: 'Optional draft_response_candidates UUID.' },
        rank: { type: 'number', description: 'Optional 1-based rank from the latest candidate list, e.g. 1 for the newest candidate shown first.' },
        status: {
          type: 'string',
          enum: ['candidate', 'drafted', 'dismissed', 'sent'],
          description: 'Candidate status to resolve by rank. Default: candidate.',
        },
        limit: { type: 'number', description: 'How many ordered candidates to consider when resolving by rank. Default 15, max 25.' },
      },
    },
  },
  {
    name: 'record_draft_feedback',
    description: 'Store Grant correction context for a draft response so future drafts for that contact/topic can use it.',
    input_schema: {
      type: 'object',
      properties: {
        candidate_id: { type: 'string', description: 'Optional draft_response_candidates UUID if known.' },
        message_id: { type: 'string', description: 'Optional Outlook/Graph message ID for the original email.' },
        sender_email: { type: 'string', description: 'Sender/contact email address, if known.' },
        original_draft: { type: 'string', description: 'The draft text Grant corrected, if available.' },
        user_feedback: { type: 'string', description: 'Grant correction or preference, e.g. "Do not mention BECU; ask for insurance cert by Friday."' },
        revised_draft: { type: 'string', description: 'Revised draft text, if already produced.' },
        extracted_guidance: { type: 'string', description: 'Reusable guidance distilled from Grant feedback.' },
      },
      required: ['user_feedback'],
    },
  },
];

// --- Tool execution ---

function normalizeSearchTerm(query) {
  return (query || '').trim().replace(/\s+/g, ' ');
}

function escapeIlike(value) {
  return value
    .replace(/[(),]/g, ' ')
    .replace(/[%_]/g, '\\$&')
    .trim();
}

function boundedLimit(limit, fallback = 8, max = 15) {
  const numericLimit = Number(limit);
  if (!Number.isFinite(numericLimit) || numericLimit <= 0) return fallback;
  return Math.min(Math.floor(numericLimit), max);
}

function truncateText(text, max = 7000) {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  return normalized.length > max ? normalized.slice(0, max) : normalized;
}

function embeddingToSqlVector(embedding) {
  return embedding?.length ? `[${embedding.join(',')}]` : null;
}

function isMissingRpcError(error) {
  return error?.code === 'PGRST202';
}

function isMissingTableError(error) {
  return error?.code === '42P01'
    || error?.code === 'PGRST205'
    || /could not find the table|relation .* does not exist/i.test(error?.message || '');
}

function memorySearchTerms(query) {
  return normalizeSearchTerm(query)
    .toLowerCase()
    .split(/\s+/)
    .map(term => term.replace(/[^a-z0-9@.-]/g, ''))
    .filter(term => term.length > 2)
    .slice(0, 8);
}

function scoreMemoryChunk(row, terms) {
  const title = (row.title || '').toLowerCase();
  const text = (row.chunk_text || '').toLowerCase();
  const summary = (row.chunk_summary || '').toLowerCase();
  return terms.reduce((score, term) => {
    if (title.includes(term)) return score + 3;
    if (summary.includes(term)) return score + 2;
    if (text.includes(term)) return score + 1;
    return score;
  }, 0);
}

function buildCardTypeFilter(cardType) {
  const allowedTypes = new Set([
    'property',
    'investment_profile',
    'owner_investor',
    'team_member',
    'operating_context',
    'project',
    'decision',
    'commitment',
    'open_loop',
    'draft_feedback',
    'organization'
  ]);
  return allowedTypes.has(cardType) ? cardType : null;
}

function scoreContextCard(row, terms) {
  const title = (row.title || '').toLowerCase();
  const summary = (row.summary || '').toLowerCase();
  const facts = JSON.stringify(row.facts || {}).toLowerCase();
  return terms.reduce((score, term) => {
    if (title.includes(term)) return score + 4;
    if (summary.includes(term)) return score + 2;
    if (facts.includes(term)) return score + 1;
    return score;
  }, 0);
}

function uniqueArray(values) {
  return [...new Set(values.filter(Boolean))];
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
  if (
    text.includes('memory')
    || text.includes('entity')
    || text.includes('context')
    || text.includes('property_profile')
    || text.includes('owner_investor')
    || text.includes('real_estate_schedule')
  ) {
    return 'supabase_memory';
  }
  return null;
}

function sourceSystemNote(sourceSystem) {
  const notes = {
    appfolio: 'current property, tenant, accounting, and ledger status',
    email: 'conversation history, requests, promises, and attachments',
    whatsapp: 'informal work conversation history',
    slack: 'team communication, approvals, and bot workflow state',
    supabase_memory: 'assistant memory, summaries, open loops, commitments, and context cards',
    github: 'code and repository history',
    vercel: 'deployed app and runtime configuration state',
  };
  return notes[sourceSystem] || 'supporting memory';
}

function sourceSystemsForContextCard(row) {
  const refs = Array.isArray(row.source_refs) ? row.source_refs : [];
  const fromRefs = refs.flatMap(ref => [
    sourceSystemFromValue(ref.table),
    sourceSystemFromValue(ref.source_type),
  ]);
  const fromFacts = [
    sourceSystemFromValue(row.card_type),
    sourceSystemFromValue(row.facts?.source_type),
    sourceSystemFromValue(row.facts?.source_table),
  ];
  return uniqueArray([...fromRefs, ...fromFacts, 'supabase_memory']);
}

function sourceSystemForMemoryChunk(row) {
  return sourceSystemFromValue(row.source_table)
    || sourceSystemFromValue(row.source_type)
    || 'supabase_memory';
}

function daysSince(value) {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return Math.floor((Date.now() - time) / 86_400_000);
}

function confidenceHint({ evidenceCount = 0, lastVerifiedAt = null, sourceSystems = [], thin = false }) {
  const ageDays = daysSince(lastVerifiedAt);
  if (thin || evidenceCount <= 0) return 'low';
  if (sourceSystems.includes('appfolio') && ageDays !== null && ageDays <= 30) return 'high';
  if (evidenceCount >= 3 && (ageDays === null || ageDays <= 120)) return 'high';
  if (evidenceCount >= 1 && (ageDays === null || ageDays <= 240)) return 'medium';
  return 'low';
}

function evidenceCountFromRefs(sourceRefs) {
  if (!Array.isArray(sourceRefs)) return 0;
  return sourceRefs.filter(ref => ref && (ref.pk || ref.table || ref.source_type)).length;
}

function attachContextCardTrust(row) {
  const sourceSystems = sourceSystemsForContextCard(row);
  const evidenceCount = Math.max(1, evidenceCountFromRefs(row.source_refs));
  const lastVerifiedAt = row.source_updated_at || row.last_seen_at || row.updated_at || null;
  return {
    ...row,
    trust: {
      source_systems: sourceSystems,
      source_of_truth: sourceSystems.map(system => ({
        system,
        role: sourceSystemNote(system),
      })),
      evidence_count: evidenceCount,
      last_verified_at: lastVerifiedAt,
      confidence_hint: confidenceHint({ evidenceCount, lastVerifiedAt, sourceSystems }),
      missing_information: sourceSystems.includes('appfolio') ? [] : ['current AppFolio status not verified by this result'],
    },
  };
}

function attachMemoryChunkTrust(row) {
  const sourceSystem = sourceSystemForMemoryChunk(row);
  const thin = ['email_preview', 'attachment_metadata'].includes(row.source_type);
  const lastVerifiedAt = row.updated_at || row.created_at || null;
  return {
    ...row,
    trust: {
      source_systems: [sourceSystem],
      source_of_truth: [{
        system: sourceSystem,
        role: sourceSystemNote(sourceSystem),
      }],
      evidence_count: 1,
      last_verified_at: lastVerifiedAt,
      confidence_hint: confidenceHint({
        evidenceCount: 1,
        lastVerifiedAt,
        sourceSystems: [sourceSystem],
        thin,
      }),
      missing_information: thin ? ['result may be based on preview or metadata only'] : [],
    },
  };
}

function buildTrustSummary(results) {
  const rows = Array.isArray(results) ? results : [];
  const sourceSystems = uniqueArray(rows.flatMap(row => row.trust?.source_systems || []));
  const confidenceRank = { low: 1, medium: 2, high: 3 };
  const lowestConfidence = rows.reduce((lowest, row) => {
    const current = row.trust?.confidence_hint || 'low';
    return confidenceRank[current] < confidenceRank[lowest] ? current : lowest;
  }, rows.length ? 'high' : 'low');

  return {
    source_systems: sourceSystems,
    source_of_truth: sourceSystems.map(system => ({
      system,
      role: sourceSystemNote(system),
    })),
    evidence_count: rows.reduce((sum, row) => sum + (row.trust?.evidence_count || 0), 0),
    confidence_hint: lowestConfidence,
    last_verified_at: rows
      .map(row => row.trust?.last_verified_at)
      .filter(Boolean)
      .sort()
      .at(-1) || null,
  };
}

async function createEmbedding(text) {
  if (!process.env.OPENAI_API_KEY) return null;
  const input = truncateText(text);
  if (!input) return null;

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error('Memory search embedding failed:', {
      status: response.status,
      error: data?.error?.message || data,
    });
    return null;
  }

  return data.data?.[0]?.embedding || null;
}

async function logRetrieval({ query, toolName, resultCount, usedEmbedding, metadata = {} }) {
  const { error } = await supabase
    .from('retrieval_logs')
    .insert({
      owner_email: OWNER_EMAIL,
      query,
      tool_name: toolName,
      result_count: resultCount,
      used_embedding: usedEmbedding,
      metadata,
    });

  if (error) {
    console.error('Retrieval log write failed:', { query, toolName, error });
  }
}

function jsonForLog(value, max = 12000) {
  try {
    const json = JSON.stringify(value ?? {});
    if (json.length <= max) return value ?? {};
    return {
      truncated: true,
      original_length: json.length,
      preview: json.slice(0, max),
    };
  } catch (error) {
    return {
      unserializable: true,
      error: error.message,
    };
  }
}

function firstString(...values) {
  return values.find(value => typeof value === 'string' && value.trim()) || null;
}

async function logAgentAction({
  status,
  toolName,
  slackThreadTs,
  input,
  result = {},
  errorMessage = null,
}) {
  const { error } = await supabase
    .from('agent_actions')
    .insert({
      owner_email: OWNER_EMAIL,
      action_type: 'tool_call',
      status,
      tool_name: toolName,
      slack_thread_ts: slackThreadTs || null,
      graph_message_id: firstString(
        input?.message_id,
        input?.id,
        input?.draft_id,
        result?.message_id,
        result?.draft_id,
        result?.id
      ),
      graph_conversation_id: firstString(
        input?.conversation_id,
        result?.conversation_id,
        result?.digest_item?.graph_conversation_id,
        result?.email?.graph_conversation_id
      ),
      input: jsonForLog(input),
      result: jsonForLog(result),
      error_message: errorMessage,
    });

  if (error) {
    console.error('Agent action log write failed:', { toolName, status, error });
  }
}

function buildEntityTypeFilter(entityType) {
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
  return allowedTypes.has(entityType) ? entityType : null;
}

async function resolveDigestItem(threadTs, itemNumber) {
  if (!threadTs) {
    throw new Error('No Slack thread timestamp available for digest item lookup.');
  }

  const { data: digestRun, error: runError } = await supabase
    .from('digest_runs')
    .select('id, slack_thread_ts, run_started_at, status')
    .eq('slack_thread_ts', threadTs)
    .order('run_started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (runError) throw new Error(`Digest run lookup failed: ${runError.message}`);
  if (!digestRun) throw new Error(`No digest run found for Slack thread ${threadTs}.`);

  const { data: digestItem, error: itemError } = await supabase
    .from('digest_items')
    .select('id, item_number, graph_message_id, graph_conversation_id, sender_name, sender_email, subject, received_at, classification, action_status, raw_digest_input')
    .eq('digest_run_id', digestRun.id)
    .eq('item_number', itemNumber)
    .maybeSingle();

  if (itemError) throw new Error(`Digest item lookup failed: ${itemError.message}`);
  if (!digestItem) throw new Error(`No digest item #${itemNumber} found for this Slack thread.`);

  const { data: emailMemory, error: emailError } = await supabase
    .from('email_messages')
    .select('graph_message_id, graph_conversation_id, subject, sender_name, sender_email, received_at, body_preview, importance, is_read, has_attachments')
    .eq('graph_message_id', digestItem.graph_message_id)
    .maybeSingle();

  if (emailError) {
    console.error('Failed to load email memory for digest item:', {
      graph_message_id: digestItem.graph_message_id,
      error: emailError
    });
  }

  return {
    digest_run: digestRun,
    digest_item: digestItem,
    email: emailMemory || null,
    message_id: digestItem.graph_message_id,
    conversation_id: digestItem.graph_conversation_id,
  };
}

async function updateDigestItemStatus(threadTs, itemNumber, actionStatus) {
  const resolved = await resolveDigestItem(threadTs, itemNumber);

  const { error } = await supabase
    .from('digest_items')
    .update({
      action_status: actionStatus,
      updated_at: new Date().toISOString()
    })
    .eq('id', resolved.digest_item.id);

  if (error) throw new Error(`Digest item status update failed: ${error.message}`);

  return {
    item_number: itemNumber,
    action_status: actionStatus,
    message_id: resolved.message_id,
    subject: resolved.digest_item.subject,
  };
}

async function searchMemoryEntities(input) {
  const query = normalizeSearchTerm(input.query);
  if (!query) throw new Error('Search query is required.');

  const limit = boundedLimit(input.limit);
  const escapedQuery = escapeIlike(query);
  let entityQuery = supabase
    .from('entities')
    .select('id, entity_type, name, current_summary, metadata, first_seen_at, last_seen_at')
    .eq('owner_email', OWNER_EMAIL)
    .or(`name.ilike.%${escapedQuery}%,normalized_name.ilike.%${escapedQuery}%,current_summary.ilike.%${escapedQuery}%`)
    .order('last_seen_at', { ascending: false })
    .limit(limit);

  const entityType = buildEntityTypeFilter(input.entity_type);
  if (entityType) entityQuery = entityQuery.eq('entity_type', entityType);

  const { data, error } = await entityQuery;
  if (error) throw new Error(`Entity memory search failed: ${error.message}`);

  return {
    query,
    entity_type: entityType,
    results: data || [],
  };
}

async function searchContextCards(input) {
  const query = normalizeSearchTerm(input.query);
  if (!query) throw new Error('Search query is required.');

  const limit = boundedLimit(input.limit, 8, 12);
  const terms = memorySearchTerms(query);
  const anchor = terms[0] || query;
  const escapedAnchor = escapeIlike(anchor);
  const cardType = buildCardTypeFilter(input.card_type);

  let cardQuery = supabase
    .from('context_cards')
    .select('id, card_type, card_key, title, summary, facts, source_refs, status, importance, last_seen_at, source_updated_at, updated_at')
    .eq('owner_email', OWNER_EMAIL)
    .eq('status', 'active')
    .or(`title.ilike.%${escapedAnchor}%,summary.ilike.%${escapedAnchor}%,card_key.ilike.%${escapedAnchor}%`)
    .order('updated_at', { ascending: false })
    .limit(Math.max(limit * 6, 30));

  if (cardType) cardQuery = cardQuery.eq('card_type', cardType);

  const { data, error } = await cardQuery;
  if (error) {
    if (isMissingTableError(error)) {
      const fallback = await searchMemory(input);
      return {
        query,
        card_type: cardType,
        mode: 'context_cards_missing_memory_fallback',
        trust_summary: fallback.trust_summary,
        results: fallback.results,
      };
    }
    throw new Error(`Context card search failed: ${error.message}`);
  }

  const results = (data || [])
    .map(row => ({
      ...row,
      card_score: scoreContextCard(row, terms),
    }))
    .filter(row => row.card_score > 0 || !terms.length)
    .sort((a, b) => {
      if (b.card_score !== a.card_score) return b.card_score - a.card_score;
      if (a.importance !== b.importance) return a.importance === 'high' ? -1 : 1;
      return new Date(b.updated_at || b.last_seen_at) - new Date(a.updated_at || a.last_seen_at);
    })
    .slice(0, limit)
    .map(attachContextCardTrust);

  await logRetrieval({
    query,
    toolName: 'search_context_cards',
    resultCount: results.length,
    usedEmbedding: false,
    metadata: {
      mode: 'context_card_keyword',
      card_type: cardType,
    },
  });

  return {
    query,
    card_type: cardType,
    mode: 'context_card_keyword',
    trust_summary: buildTrustSummary(results),
    results,
  };
}

async function searchMemory(input) {
  const query = normalizeSearchTerm(input.query);
  if (!query) throw new Error('Search query is required.');

  const limit = boundedLimit(input.limit);
  const embedding = await createEmbedding(query);
  const { data, error } = await supabase.rpc('search_memory_chunks_api', {
    p_owner_email: OWNER_EMAIL,
    p_query: query,
    p_query_embedding_text: embeddingToSqlVector(embedding),
    p_match_count: limit,
  });

  if (error && !isMissingRpcError(error)) {
    throw new Error(`Hybrid memory search failed: ${error.message}`);
  }

  const fallbackResults = error ? await searchMemoryByKeyword(query, limit) : null;
  const results = (fallbackResults || data || []).map(attachMemoryChunkTrust);

  await logRetrieval({
    query,
    toolName: 'search_memory',
    resultCount: results.length,
    usedEmbedding: Boolean(embedding && !fallbackResults),
    metadata: {
      embedding_model: embedding && !fallbackResults ? EMBEDDING_MODEL : null,
      mode: fallbackResults ? 'direct_keyword_fallback' : 'rpc',
    },
  });

  return {
    query,
    mode: fallbackResults
      ? 'direct_keyword_fallback'
      : (embedding ? 'hybrid_vector_keyword' : 'keyword_full_text'),
    trust_summary: buildTrustSummary(results),
    results,
  };
}

async function searchMemoryByKeyword(query, limit) {
  const terms = memorySearchTerms(query);
  if (!terms.length) return [];

  let memoryQuery = supabase
    .from('memory_chunks')
    .select('id, source_type, source_table, source_pk, graph_message_id, graph_conversation_id, title, chunk_text, chunk_summary, metadata, created_at, updated_at')
    .eq('owner_email', OWNER_EMAIL)
    .limit(Math.max(limit * 6, 30));

  for (const term of terms.slice(0, 5)) {
    const escapedTerm = escapeIlike(term);
    memoryQuery = memoryQuery.or(`title.ilike.%${escapedTerm}%,chunk_text.ilike.%${escapedTerm}%,chunk_summary.ilike.%${escapedTerm}%`);
  }

  const { data, error } = await memoryQuery;
  if (error) throw new Error(`Direct memory search failed: ${error.message}`);

  return (data || [])
    .map(row => ({
      ...row,
      keyword_score: scoreMemoryChunk(row, terms),
      vector_score: null,
      combined_score: scoreMemoryChunk(row, terms),
    }))
    .filter(row => row.combined_score > 0)
    .sort((a, b) => {
      if (b.combined_score !== a.combined_score) return b.combined_score - a.combined_score;
      return new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at);
    })
    .slice(0, limit)
    .map(attachMemoryChunkTrust);
}

async function searchThreadMemory(input) {
  const query = normalizeSearchTerm(input.query);
  if (!query) throw new Error('Search query is required.');

  const limit = boundedLimit(input.limit);
  const escapedQuery = escapeIlike(query);
  const { data, error } = await supabase
    .from('email_threads')
    .select('id, graph_conversation_id, latest_subject, participant_emails, participant_names, first_message_at, last_message_at, last_graph_message_id, message_count, current_summary, open_items, status, summary_updated_at')
    .eq('owner_email', OWNER_EMAIL)
    .or(`latest_subject.ilike.%${escapedQuery}%,current_summary.ilike.%${escapedQuery}%`)
    .order('last_message_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Thread memory search failed: ${error.message}`);

  return {
    query,
    results: data || [],
  };
}

async function getEntityContext(input) {
  const limit = boundedLimit(input.limit);

  const { data: entity, error: entityError } = await supabase
    .from('entities')
    .select('id, entity_type, name, current_summary, metadata, first_seen_at, last_seen_at')
    .eq('owner_email', OWNER_EMAIL)
    .eq('id', input.entity_id)
    .maybeSingle();

  if (entityError) throw new Error(`Entity lookup failed: ${entityError.message}`);
  if (!entity) throw new Error('No entity found for that entity_id.');

  const { data: mentions, error: mentionsError } = await supabase
    .from('entity_mentions')
    .select('id, graph_message_id, graph_conversation_id, source_type, mention_text, confidence, metadata, created_at')
    .eq('entity_id', entity.id)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (mentionsError) throw new Error(`Entity mentions lookup failed: ${mentionsError.message}`);

  const messageIds = [...new Set((mentions || []).map(mention => mention.graph_message_id).filter(Boolean))];
  const conversationIds = [...new Set((mentions || []).map(mention => mention.graph_conversation_id).filter(Boolean))];

  const { data: messages, error: messagesError } = messageIds.length
    ? await supabase
      .from('email_messages')
      .select('graph_message_id, graph_conversation_id, subject, sender_name, sender_email, received_at, body_preview, importance, is_read, has_attachments')
      .in('graph_message_id', messageIds)
    : { data: [], error: null };

  if (messagesError) throw new Error(`Mention email lookup failed: ${messagesError.message}`);

  const { data: threads, error: threadsError } = conversationIds.length
    ? await supabase
      .from('email_threads')
      .select('graph_conversation_id, latest_subject, last_message_at, message_count, current_summary, open_items, status')
      .in('graph_conversation_id', conversationIds)
    : { data: [], error: null };

  if (threadsError) throw new Error(`Mention thread lookup failed: ${threadsError.message}`);

  return {
    entity,
    mentions: mentions || [],
    messages: messages || [],
    threads: threads || [],
  };
}

async function listDraftResponseCandidates(input) {
  const limit = boundedLimit(input.limit);
  const status = input.status || 'candidate';
  const { data, error } = await supabase
    .from('draft_response_candidates')
    .select('id, status, graph_message_id, graph_conversation_id, sender_email, sender_name, subject, received_at, known_contact_score, inbound_count, outbound_count, back_and_forth_thread_count, reason, context_summary, draft_graph_message_id, metadata, created_at, updated_at')
    .eq('owner_email', OWNER_EMAIL)
    .eq('status', status)
    .order('received_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Draft candidate lookup failed: ${error.message}`);
  return { status, results: data || [] };
}

async function resolveDraftResponseCandidate(input) {
  const status = input.status || 'candidate';
  const rank = Number(input.rank || 0);
  let candidate = null;
  let orderedCandidates = [];

  if (input.candidate_id) {
    const { data, error } = await supabase
      .from('draft_response_candidates')
      .select('id, status, graph_message_id, graph_conversation_id, sender_email, sender_name, subject, received_at, known_contact_score, inbound_count, outbound_count, back_and_forth_thread_count, reason, context_summary, draft_graph_message_id, metadata, created_at, updated_at')
      .eq('owner_email', OWNER_EMAIL)
      .eq('id', input.candidate_id)
      .maybeSingle();

    if (error) throw new Error(`Draft candidate lookup failed: ${error.message}`);
    candidate = data;
  } else {
    if (!Number.isFinite(rank) || rank < 1) {
      throw new Error('Provide candidate_id or a 1-based rank from the candidate list.');
    }

    const limit = boundedLimit(input.limit, 15, 25);
    const { data, error } = await supabase
      .from('draft_response_candidates')
      .select('id, status, graph_message_id, graph_conversation_id, sender_email, sender_name, subject, received_at, known_contact_score, inbound_count, outbound_count, back_and_forth_thread_count, reason, context_summary, draft_graph_message_id, metadata, created_at, updated_at')
      .eq('owner_email', OWNER_EMAIL)
      .eq('status', status)
      .order('received_at', { ascending: false })
      .limit(limit);

    if (error) throw new Error(`Draft candidate rank lookup failed: ${error.message}`);
    orderedCandidates = data || [];
    candidate = orderedCandidates[rank - 1] || null;
  }

  if (!candidate) throw new Error('No matching draft response candidate found.');

  const { data: email, error: emailError } = await supabase
    .from('email_messages')
    .select('id, graph_message_id, graph_conversation_id, folder, subject, sender_name, sender_email, recipients, cc_recipients, received_at, sent_at, body_preview, body_text, importance, is_read, has_attachments')
    .eq('owner_email', OWNER_EMAIL)
    .eq('graph_message_id', candidate.graph_message_id)
    .maybeSingle();

  if (emailError) throw new Error(`Candidate email lookup failed: ${emailError.message}`);

  const { data: thread, error: threadError } = candidate.graph_conversation_id
    ? await supabase
      .from('email_threads')
      .select('id, graph_conversation_id, latest_subject, participant_emails, participant_names, first_message_at, last_message_at, last_graph_message_id, message_count, current_summary, open_items, status, summary_updated_at')
      .eq('owner_email', OWNER_EMAIL)
      .eq('graph_conversation_id', candidate.graph_conversation_id)
      .maybeSingle()
    : { data: null, error: null };

  if (threadError) throw new Error(`Candidate thread lookup failed: ${threadError.message}`);

  const { data: feedback, error: feedbackError } = await supabase
    .from('draft_feedback')
    .select('id, sender_email, graph_message_id, graph_conversation_id, user_feedback, revised_draft, extracted_guidance, final_status, created_at')
    .eq('owner_email', OWNER_EMAIL)
    .eq('sender_email', candidate.sender_email)
    .order('created_at', { ascending: false })
    .limit(5);

  if (feedbackError) throw new Error(`Draft feedback lookup failed: ${feedbackError.message}`);

  return {
    resolved_by: input.candidate_id ? 'candidate_id' : 'rank',
    rank: input.candidate_id ? null : rank,
    candidate,
    email,
    thread,
    prior_feedback: feedback || [],
    memory_query_suggestion: [candidate.sender_email, candidate.subject].filter(Boolean).join(' '),
  };
}

function boundedDays(value, fallback = 7, max = 60) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(Math.floor(numeric), max);
}

function compactForgottenText(value, max = 420) {
  return truncateText(value, max);
}

function latestTimestamp(...values) {
  return values
    .filter(Boolean)
    .sort()
    .at(-1) || null;
}

function forgottenAgeDays(item) {
  return daysSince(latestTimestamp(item.updated_at, item.received_at, item.due_at, item.last_seen_at, item.source_updated_at));
}

function forgottenItemScore(item, staleDays) {
  const age = forgottenAgeDays(item) || 0;
  let score = Math.min(age, 60);
  if (item.due_at && Date.parse(item.due_at) < Date.now()) score += 35;
  if (item.priority === 'high') score += 25;
  if (item.status === 'waiting') score += 15;
  if (item.kind === 'draft_candidate') score += 18;
  if (item.kind === 'digest_item') score += 12;
  if (age >= staleDays) score += 10;
  return score;
}

function isForgottenItemSnoozed(item) {
  const snoozedUntil = item.raw?.metadata?.forgotten_feedback?.snoozed_until
    || item.raw?.raw_digest_input?.forgotten_feedback?.snoozed_until
    || item.raw?.facts?.forgotten_feedback?.snoozed_until;
  return snoozedUntil && Date.parse(snoozedUntil) > Date.now();
}

function forgottenTrust({ sourceSystem = 'supabase_memory', evidenceCount = 1, lastVerifiedAt = null, missingInformation = [] }) {
  return {
    source_systems: [sourceSystem],
    source_of_truth: [{
      system: sourceSystem,
      role: sourceSystemNote(sourceSystem),
    }],
    evidence_count: evidenceCount,
    last_verified_at: lastVerifiedAt,
    confidence_hint: confidenceHint({
      evidenceCount,
      lastVerifiedAt,
      sourceSystems: [sourceSystem],
    }),
    missing_information: missingInformation,
  };
}

function forgottenFromOpenLoop(item, staleDays) {
  const lastVerifiedAt = latestTimestamp(item.updated_at, item.due_at);
  return {
    kind: 'open_loop',
    id: item.id,
    title: item.title,
    status: item.status,
    priority: item.priority,
    due_at: item.due_at,
    last_seen_at: item.updated_at,
    age_days: daysSince(item.updated_at),
    reason: item.due_at && Date.parse(item.due_at) < Date.now()
      ? 'Open loop is past its due date.'
      : `Open loop is still ${item.status}${daysSince(item.updated_at) >= staleDays ? ' and stale' : ''}.`,
    summary: compactForgottenText(item.description || item.metadata?.source_subject || ''),
    source_label: item.metadata?.source_subject || 'open_loops',
    suggested_next_action: 'Confirm owner and decide whether to close, delegate, or follow up.',
    trust: forgottenTrust({ lastVerifiedAt }),
    raw: item,
  };
}

function forgottenFromCommitment(item, staleDays) {
  const lastVerifiedAt = latestTimestamp(item.updated_at, item.due_at);
  return {
    kind: 'commitment',
    id: item.id,
    title: item.title,
    status: item.status,
    owner_name: item.owner_name,
    due_at: item.due_at,
    last_seen_at: item.updated_at,
    age_days: daysSince(item.updated_at),
    reason: item.due_at && Date.parse(item.due_at) < Date.now()
      ? 'Commitment appears overdue.'
      : `Commitment is still ${item.status}${daysSince(item.updated_at) >= staleDays ? ' and has not moved recently' : ''}.`,
    summary: compactForgottenText(item.commitment || item.metadata?.source_subject || ''),
    source_label: item.metadata?.source_subject || 'commitments',
    suggested_next_action: item.owner_name
      ? `Ask ${item.owner_name} for a status update or mark it done if complete.`
      : 'Confirm who owns this and whether it is still active.',
    trust: forgottenTrust({ lastVerifiedAt }),
    raw: item,
  };
}

function forgottenFromDraftCandidate(item) {
  const lastVerifiedAt = item.received_at || item.updated_at || item.created_at;
  return {
    kind: 'draft_candidate',
    id: item.id,
    title: item.subject || `Reply candidate from ${item.sender_name || item.sender_email}`,
    status: item.status,
    sender: item.sender_name || item.sender_email,
    received_at: item.received_at,
    last_seen_at: lastVerifiedAt,
    age_days: daysSince(lastVerifiedAt),
    reason: 'Known contact email appears to be asking for a response and has not been drafted/sent.',
    summary: compactForgottenText(item.context_summary || item.reason || ''),
    source_label: `${item.sender_name || item.sender_email}${item.subject ? `: ${item.subject}` : ''}`,
    suggested_next_action: 'Review whether this needs a short reply or dismissal.',
    trust: forgottenTrust({ sourceSystem: 'email', lastVerifiedAt }),
    raw: item,
  };
}

function forgottenFromDigestItem(item) {
  const lastVerifiedAt = item.received_at || item.created_at;
  return {
    kind: 'digest_item',
    id: item.id,
    title: item.subject || `Digest item #${item.item_number}`,
    status: item.action_status,
    sender: item.sender_name || item.sender_email,
    received_at: item.received_at,
    last_seen_at: lastVerifiedAt,
    age_days: daysSince(lastVerifiedAt),
    reason: `Digest item is still marked ${item.action_status}.`,
    summary: compactForgottenText(item.raw_digest_input?.body_preview || item.raw_digest_input?.preview || ''),
    source_label: `Digest #${item.item_number}${item.subject ? `: ${item.subject}` : ''}`,
    suggested_next_action: 'Handle it, mark it waiting/done, or dismiss it in the digest thread.',
    trust: forgottenTrust({ sourceSystem: 'slack', lastVerifiedAt }),
    raw: item,
  };
}

function forgottenFromContextCard(item) {
  const sourceSystems = sourceSystemsForContextCard(item);
  const lastVerifiedAt = item.source_updated_at || item.last_seen_at || item.updated_at;
  return {
    kind: `context_${item.card_type}`,
    id: item.id,
    title: item.title,
    status: item.status,
    importance: item.importance,
    last_seen_at: lastVerifiedAt,
    age_days: daysSince(lastVerifiedAt),
    reason: `${item.card_type.replace('_', ' ')} context card may indicate an active loose end.`,
    summary: compactForgottenText(item.summary || ''),
    source_label: item.title,
    suggested_next_action: 'Ask for a focused brief if this still looks active.',
    trust: {
      source_systems: sourceSystems,
      source_of_truth: sourceSystems.map(system => ({
        system,
        role: sourceSystemNote(system),
      })),
      evidence_count: Math.max(1, evidenceCountFromRefs(item.source_refs)),
      last_verified_at: lastVerifiedAt,
      confidence_hint: confidenceHint({
        evidenceCount: Math.max(1, evidenceCountFromRefs(item.source_refs)),
        lastVerifiedAt,
        sourceSystems,
      }),
      missing_information: sourceSystems.includes('appfolio') ? [] : ['current AppFolio status not verified by this result'],
    },
    raw: item,
  };
}

async function listForgottenItems(input = {}) {
  const staleDays = boundedDays(input.days_stale, 7, 60);
  const limit = boundedLimit(input.limit, 8, 15);
  const staleCutoff = new Date(Date.now() - staleDays * 86_400_000).toISOString();

  const [
    openLoops,
    commitments,
    draftCandidates,
    digestItems,
    contextCards,
    latestPriority,
  ] = await Promise.all([
    supabase
      .from('open_loops')
      .select('id, title, description, priority, due_at, status, metadata, created_at, updated_at')
      .eq('owner_email', OWNER_EMAIL)
      .in('status', ['open', 'waiting'])
      .or(`updated_at.lte.${staleCutoff},due_at.lte.${new Date().toISOString()},priority.eq.high`)
      .order('updated_at', { ascending: true })
      .limit(30),
    supabase
      .from('commitments')
      .select('id, title, commitment, owner_name, due_at, status, metadata, created_at, updated_at')
      .eq('owner_email', OWNER_EMAIL)
      .in('status', ['open', 'waiting'])
      .or(`updated_at.lte.${staleCutoff},due_at.lte.${new Date().toISOString()}`)
      .order('updated_at', { ascending: true })
      .limit(30),
    supabase
      .from('draft_response_candidates')
      .select('id, status, graph_message_id, graph_conversation_id, sender_email, sender_name, subject, received_at, reason, context_summary, known_contact_score, back_and_forth_thread_count, created_at, updated_at')
      .eq('owner_email', OWNER_EMAIL)
      .eq('status', 'candidate')
      .order('received_at', { ascending: true })
      .limit(20),
    supabase
      .from('digest_items')
      .select('id, item_number, sender_name, sender_email, subject, received_at, classification, action_status, raw_digest_input, created_at')
      .in('action_status', ['open', 'waiting'])
      .order('created_at', { ascending: true })
      .limit(20),
    supabase
      .from('context_cards')
      .select('id, card_type, card_key, title, summary, facts, source_refs, status, importance, last_seen_at, source_updated_at, updated_at')
      .eq('owner_email', OWNER_EMAIL)
      .eq('status', 'active')
      .in('card_type', ['open_loop', 'commitment', 'project'])
      .or(`last_seen_at.lte.${staleCutoff},updated_at.lte.${staleCutoff},importance.eq.high`)
      .order('updated_at', { ascending: true })
      .limit(30),
    supabase
      .from('daily_priority_suggestions')
      .select('suggestion_date, status, title, activity, first_step, evidence, scoring, slack_message_ts, created_at')
      .eq('owner_email', OWNER_EMAIL)
      .order('suggestion_date', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const errors = [
    openLoops.error,
    commitments.error,
    draftCandidates.error,
    digestItems.error,
    contextCards.error,
    latestPriority.error,
  ].filter(Boolean);
  if (errors.length) throw new Error(`Forgotten item lookup failed: ${errors[0].message}`);

  const candidates = [
    ...(openLoops.data || []).map(item => forgottenFromOpenLoop(item, staleDays)),
    ...(commitments.data || []).map(item => forgottenFromCommitment(item, staleDays)),
    ...(draftCandidates.data || []).map(forgottenFromDraftCandidate),
    ...(digestItems.data || []).map(forgottenFromDigestItem),
    ...(contextCards.data || []).map(forgottenFromContextCard),
  ]
    .filter(item => !isForgottenItemSnoozed(item))
    .map(item => ({
      ...item,
      score: forgottenItemScore(item, staleDays),
    }));

  const ranked = candidates
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.age_days || 0) - (a.age_days || 0);
    })
    .slice(0, limit);

  await logRetrieval({
    query: 'what am i forgetting',
    toolName: 'list_forgotten_items',
    resultCount: ranked.length,
    usedEmbedding: false,
    metadata: {
      stale_days: staleDays,
      total_candidates: candidates.length,
      latest_priority_date: latestPriority.data?.suggestion_date || null,
    },
  });

  return {
    stale_days: staleDays,
    total_candidates: candidates.length,
    trust_summary: buildTrustSummary(ranked),
    latest_priority: latestPriority.data || null,
    results: ranked,
    guidance: 'Summarize the top 3-6 items in Slack. Keep it short, include why it may be forgotten, next action, and confidence/source caveat when useful.',
  };
}

function normalizeForgottenAction(action) {
  const normalized = String(action || '').toLowerCase().trim();
  const aliases = {
    dismissed: 'dismiss',
    dismissing: 'dismiss',
    complete: 'done',
    completed: 'done',
    closed: 'done',
    close: 'done',
    wait: 'waiting',
    important: 'priority',
    prioritize: 'priority',
    prioritized: 'priority',
    reopen: 'open',
    opened: 'open',
  };
  return aliases[normalized] || normalized;
}

function updatePayloadForAction({ action, existingMetadata = {}, note = null, snoozeDays = 7 }) {
  const now = new Date().toISOString();
  const feedback = {
    ...(existingMetadata.forgotten_feedback || {}),
    action,
    note: note || null,
    updated_at: now,
    source: 'slack_assistant',
  };
  if (action === 'snooze') {
    feedback.snoozed_until = new Date(Date.now() + boundedDays(snoozeDays, 7, 90) * 86_400_000).toISOString();
  } else {
    delete feedback.snoozed_until;
  }
  return {
    ...existingMetadata,
    forgotten_feedback: feedback,
  };
}

function statusForForgottenAction(action, itemKind) {
  if (action === 'done') return itemKind === 'draft_candidate' ? 'dismissed' : 'done';
  if (action === 'dismiss') return 'dismissed';
  if (action === 'waiting' || action === 'snooze') return 'waiting';
  if (action === 'open') return itemKind === 'draft_candidate' ? 'candidate' : 'open';
  return null;
}

function baseForgottenKind(kind) {
  const text = String(kind || '');
  if (text.startsWith('context_')) return 'context_card';
  return text;
}

async function resolveForgottenItemReference(input, threadTs) {
  if (input.item_id && input.item_kind) {
    return {
      id: input.item_id,
      kind: input.item_kind,
      title: input.title || null,
      source: 'direct',
    };
  }

  const rank = Number(input.rank || 0);
  if (!Number.isFinite(rank) || rank < 1) {
    throw new Error('Provide an item number like #2 from the latest forgotten-items list.');
  }

  let query = supabase
    .from('agent_actions')
    .select('id, result, created_at, slack_thread_ts')
    .eq('owner_email', OWNER_EMAIL)
    .eq('tool_name', 'list_forgotten_items')
    .eq('status', 'succeeded')
    .order('created_at', { ascending: false })
    .limit(1);

  if (threadTs) query = query.eq('slack_thread_ts', threadTs);

  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`Forgotten item reference lookup failed: ${error.message}`);
  if (!data && threadTs) {
    const { data: latestAnyThread, error: latestError } = await supabase
      .from('agent_actions')
      .select('id, result, created_at, slack_thread_ts')
      .eq('owner_email', OWNER_EMAIL)
      .eq('tool_name', 'list_forgotten_items')
      .eq('status', 'succeeded')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestError) throw new Error(`Forgotten item fallback lookup failed: ${latestError.message}`);
    if (!latestAnyThread) throw new Error('No previous forgotten-items list found to resolve that item number.');
    const fallbackItem = latestAnyThread.result?.results?.[rank - 1];
    if (!fallbackItem) throw new Error(`No forgotten item #${rank} found in the latest list.`);
    return {
      ...fallbackItem,
      source: 'latest_any_thread',
      list_action_id: latestAnyThread.id,
      list_created_at: latestAnyThread.created_at,
    };
  }

  if (!data) throw new Error('No previous forgotten-items list found to resolve that item number.');
  const item = data.result?.results?.[rank - 1];
  if (!item) throw new Error(`No forgotten item #${rank} found in the latest list.`);
  return {
    ...item,
    source: 'thread',
    list_action_id: data.id,
    list_created_at: data.created_at,
  };
}

async function fetchRowForForgottenItem(table, id, select = 'id, metadata') {
  const { data, error } = await supabase
    .from(table)
    .select(select)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`Forgotten item ${table} lookup failed: ${error.message}`);
  if (!data) throw new Error(`No ${table} row found for forgotten item.`);
  return data;
}

async function updateForgottenItemStatus(input, threadTs) {
  const action = normalizeForgottenAction(input.action);
  if (!['done', 'dismiss', 'waiting', 'snooze', 'priority', 'open'].includes(action)) {
    throw new Error(`Unsupported forgotten item action: ${input.action}`);
  }

  const item = await resolveForgottenItemReference(input, threadTs);
  const kind = baseForgottenKind(item.kind || input.item_kind);
  const now = new Date().toISOString();
  const note = input.note || null;
  const snoozeDays = boundedDays(input.snooze_days, 7, 90);

  let updated = null;
  let table = null;
  let appliedAction = action;

  if (kind === 'open_loop') {
    table = 'open_loops';
    const row = await fetchRowForForgottenItem(table, item.id, 'id, title, status, priority, metadata');
    const metadata = updatePayloadForAction({ action, existingMetadata: row.metadata || {}, note, snoozeDays });
    const payload = {
      metadata,
      updated_at: now,
    };
    const status = statusForForgottenAction(action, kind);
    if (status) payload.status = status;
    if (action === 'priority') payload.priority = 'high';
    const { data, error } = await supabase
      .from(table)
      .update(payload)
      .eq('owner_email', OWNER_EMAIL)
      .eq('id', item.id)
      .select('id, title, status, priority, metadata, updated_at')
      .maybeSingle();
    if (error) throw new Error(`Open loop update failed: ${error.message}`);
    updated = data;
  } else if (kind === 'commitment') {
    table = 'commitments';
    const row = await fetchRowForForgottenItem(table, item.id, 'id, title, status, metadata');
    const metadata = updatePayloadForAction({ action, existingMetadata: row.metadata || {}, note, snoozeDays });
    if (action === 'priority') metadata.priority = 'high';
    const payload = {
      metadata,
      updated_at: now,
    };
    const status = statusForForgottenAction(action, kind);
    if (status) payload.status = status;
    const { data, error } = await supabase
      .from(table)
      .update(payload)
      .eq('owner_email', OWNER_EMAIL)
      .eq('id', item.id)
      .select('id, title, status, metadata, updated_at')
      .maybeSingle();
    if (error) throw new Error(`Commitment update failed: ${error.message}`);
    updated = data;
  } else if (kind === 'draft_candidate') {
    table = 'draft_response_candidates';
    const row = await fetchRowForForgottenItem(table, item.id, 'id, subject, status, metadata');
    const metadata = updatePayloadForAction({ action, existingMetadata: row.metadata || {}, note, snoozeDays });
    if (action === 'priority') metadata.priority = 'high';
    const payload = {
      metadata,
      updated_at: now,
    };
    const status = statusForForgottenAction(action, kind);
    if (status) payload.status = status;
    const { data, error } = await supabase
      .from(table)
      .update(payload)
      .eq('owner_email', OWNER_EMAIL)
      .eq('id', item.id)
      .select('id, subject, status, metadata, updated_at')
      .maybeSingle();
    if (error) throw new Error(`Draft candidate update failed: ${error.message}`);
    updated = data;
  } else if (kind === 'digest_item') {
    table = 'digest_items';
    const row = await fetchRowForForgottenItem(table, item.id, 'id, subject, action_status, raw_digest_input');
    const rawDigestInput = updatePayloadForAction({
      action,
      existingMetadata: row.raw_digest_input || {},
      note,
      snoozeDays,
    });
    if (action === 'priority') rawDigestInput.priority = 'high';
    const payload = { raw_digest_input: rawDigestInput };
    const status = statusForForgottenAction(action, kind);
    if (status) payload.action_status = status;
    const { data, error } = await supabase
      .from(table)
      .update(payload)
      .eq('id', item.id)
      .select('id, subject, action_status, raw_digest_input')
      .maybeSingle();
    if (error) throw new Error(`Digest item update failed: ${error.message}`);
    updated = data;
  } else if (kind === 'context_card') {
    table = 'context_cards';
    const row = await fetchRowForForgottenItem(table, item.id, 'id, title, status, importance, facts');
    const facts = updatePayloadForAction({ action, existingMetadata: row.facts || {}, note, snoozeDays });
    const payload = {
      facts,
      updated_at: now,
    };
    if (action === 'dismiss') payload.status = 'dismissed';
    if (action === 'done') payload.status = 'done';
    if (action === 'open') payload.status = 'active';
    if (action === 'priority') payload.importance = 'high';
    const { data, error } = await supabase
      .from(table)
      .update(payload)
      .eq('owner_email', OWNER_EMAIL)
      .eq('id', item.id)
      .select('id, title, status, importance, facts, updated_at')
      .maybeSingle();
    if (error) throw new Error(`Context card update failed: ${error.message}`);
    updated = data;
  } else {
    throw new Error(`Cannot update forgotten item kind: ${item.kind || input.item_kind}`);
  }

  return {
    ok: true,
    action: appliedAction,
    item: {
      id: item.id,
      kind: item.kind,
      title: item.title || item.source_label || updated?.title || updated?.subject || null,
      rank: input.rank || null,
    },
    table,
    updated,
    message: action === 'snooze'
      ? `Snoozed for ${snoozeDays} day(s).`
      : `Marked ${action}.`,
  };
}

async function markDraftCandidateDrafted(graphMessageId, draftId, draftBody) {
  const { data, error } = await supabase
    .from('draft_response_candidates')
    .update({
      status: 'drafted',
      draft_graph_message_id: draftId,
      draft_body: draftBody || null,
      updated_at: new Date().toISOString(),
    })
    .eq('owner_email', OWNER_EMAIL)
    .eq('graph_message_id', graphMessageId)
    .in('status', ['candidate', 'drafted'])
    .select('id, status, graph_message_id, draft_graph_message_id, subject, sender_email')
    .maybeSingle();

  if (error) {
    console.error('Draft candidate drafted status update failed:', {
      graphMessageId,
      draftId,
      error,
    });
  }

  return data || null;
}

async function markDraftCandidateByDraftId(draftId, status) {
  const { data, error } = await supabase
    .from('draft_response_candidates')
    .update({
      status,
      updated_at: new Date().toISOString(),
    })
    .eq('owner_email', OWNER_EMAIL)
    .eq('draft_graph_message_id', draftId)
    .select('id, status, graph_message_id, draft_graph_message_id, subject, sender_email')
    .maybeSingle();

  if (error) {
    console.error('Draft candidate lifecycle status update failed:', {
      draftId,
      status,
      error,
    });
  }

  return data || null;
}

async function recordDraftFeedback(input) {
  const { data: candidate, error: candidateError } = input.candidate_id
    ? await supabase
      .from('draft_response_candidates')
      .select('id, graph_message_id, graph_conversation_id, sender_email')
      .eq('owner_email', OWNER_EMAIL)
      .eq('id', input.candidate_id)
      .maybeSingle()
    : { data: null, error: null };

  if (candidateError) throw new Error(`Draft candidate feedback lookup failed: ${candidateError.message}`);

  const senderEmail = input.sender_email || candidate?.sender_email || null;
  const graphMessageId = input.message_id || candidate?.graph_message_id || null;
  const graphConversationId = candidate?.graph_conversation_id || null;

  const { data, error } = await supabase
    .from('draft_feedback')
    .insert({
      owner_email: OWNER_EMAIL,
      candidate_id: candidate?.id || input.candidate_id || null,
      graph_message_id: graphMessageId,
      graph_conversation_id: graphConversationId,
      sender_email: senderEmail,
      original_draft: input.original_draft || null,
      user_feedback: input.user_feedback,
      revised_draft: input.revised_draft || null,
      final_status: 'noted',
      extracted_guidance: input.extracted_guidance || input.user_feedback,
      metadata: {
        source: 'slack_assistant',
      },
    })
    .select()
    .single();

  if (error) throw new Error(`Draft feedback save failed: ${error.message}`);

  if (data?.id && data.extracted_guidance) {
    const { error: chunkError } = await supabase
      .from('memory_chunks')
      .upsert({
        owner_email: OWNER_EMAIL,
        source_type: 'draft_feedback',
        source_table: 'draft_feedback',
        source_pk: data.id,
        source_id: data.id,
        graph_message_id: graphMessageId,
        graph_conversation_id: graphConversationId,
        title: senderEmail ? `Draft feedback for ${senderEmail}` : 'Draft feedback',
        chunk_summary: data.extracted_guidance,
        chunk_text: [
          senderEmail ? `Contact: ${senderEmail}` : '',
          input.original_draft ? `Original draft: ${input.original_draft}` : '',
          `Grant feedback: ${input.user_feedback}`,
          input.revised_draft ? `Revised draft: ${input.revised_draft}` : '',
          `Reusable guidance: ${data.extracted_guidance}`,
        ].filter(Boolean).join('\n'),
        metadata: {
          sender_email: senderEmail,
          candidate_id: candidate?.id || null,
        },
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'owner_email,source_type,source_pk',
      });

    if (chunkError) console.error('Draft feedback memory chunk write failed:', chunkError);
  }

  return { saved: true, feedback: data };
}

async function executeToolInternal(name, input, token, threadTs) {
  const base = `/users/${OWNER_EMAIL}`;

  switch (name) {
    case 'list_emails': {
      const folder = input.folder || 'Inbox';
      const top = Math.min(input.top || 15, 25);
      const select = 'id,subject,from,receivedDateTime,isRead,bodyPreview';
      let url = `${base}/mailFolders/${folder}/messages?$top=${top}&$select=${select}&$orderby=receivedDateTime desc`;
      if (input.unread_only) url += '&$filter=isRead eq false';
      return graph(token, url);
    }

    case 'search_emails': {
      const top = Math.min(input.top || 10, 25);
      // Graph search requires $search with quoted string
      const url = `${base}/messages?$search="${input.query}"&$top=${top}&$select=id,subject,from,receivedDateTime,isRead,bodyPreview`;
      return graph(token, url);
    }

    case 'get_email': {
      const select = 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,conversationId';
      return graph(token, `${base}/messages/${input.id}?$select=${select}`);
    }

    case 'resolve_digest_item': {
      return resolveDigestItem(threadTs, input.item_number);
    }

    case 'create_draft_reply': {
      // Fetch original to get CC recipients we need to preserve
      const original = await graph(token, `${base}/messages/${input.message_id}?$select=ccRecipients`);
      const ccRecipients = original.ccRecipients || [];

      // Use createReply's `comment` to prepend our text above the quoted history
      // in a single call. PATCHing the body afterward strips the quoted block and
      // makes Outlook render the draft as a standalone (un-threaded) email.
      const htmlComment = input.body
        .split('\n')
        .map(line => `<div>${line || '&nbsp;'}</div>`)
        .join('');

      const draft = await graph(token, `${base}/messages/${input.message_id}/createReply`, 'POST', {
        comment: htmlComment,
        ...(ccRecipients.length && { message: { ccRecipients } }),
      });
      const candidate = await markDraftCandidateDrafted(input.message_id, draft.id, input.body);

      return {
        draft_id: draft.id,
        subject: draft.subject,
        candidate,
        message: 'Draft saved. Awaiting approval.',
      };
    }

    case 'get_recent_drafts': {
      const top = input.top || 5;
      const select = 'id,subject,toRecipients,bodyPreview,lastModifiedDateTime';
      return graph(token, `${base}/mailFolders/Drafts/messages?$top=${top}&$select=${select}&$orderby=lastModifiedDateTime desc`);
    }

    case 'create_new_draft': {
      const toRecipients = input.to.map(email => ({
        emailAddress: { address: email },
      }));
      const ccRecipients = (input.cc || []).map(email => ({
        emailAddress: { address: email },
      }));
      const draft = await graph(token, `${base}/messages`, 'POST', {
        subject: input.subject,
        body: { contentType: 'Text', content: input.body },
        toRecipients,
        ...(ccRecipients.length && { ccRecipients }),
      });
      return { draft_id: draft.id, subject: draft.subject, message: 'New draft created. Awaiting approval.' };
    }

    case 'send_draft': {
      await graph(token, `${base}/messages/${input.draft_id}/send`, 'POST', {});
      const candidate = await markDraftCandidateByDraftId(input.draft_id, 'sent');
      return { success: true, candidate, message: 'Email sent.' };
    }

    case 'update_triage_rules': {
      const projectId = 'prj_1eeFtlROsHRqaCD3HkvGC6m9XMJX';
      const teamId = 'team_1mUqHwC1cSBZNn1LlIFJJube';

      // Parse current rules
      let rules = [];
      try { rules = JSON.parse(process.env.TRIAGE_RULES || '[]'); } catch {}

      if (input.action === 'list') {
        return { rules, message: rules.length ? `${rules.length} active rule(s).` : 'No custom rules set yet.' };
      }

      if (input.action === 'add' && input.rule) {
        if (!rules.includes(input.rule)) rules.push(input.rule);
      } else if (input.action === 'remove' && input.rule) {
        rules = rules.filter(r => r !== input.rule);
      }

      const newValue = JSON.stringify(rules);

      // Find or create TRIAGE_RULES env var via Vercel API
      const listRes = await fetch(
        `https://api.vercel.com/v9/projects/${projectId}/env?teamId=${teamId}`,
        { headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` } }
      );
      const listData = await listRes.json();
      const existing = listData.envs?.find(e => e.key === 'TRIAGE_RULES');

      if (existing) {
        await fetch(
          `https://api.vercel.com/v9/projects/${projectId}/env/${existing.id}?teamId=${teamId}`,
          {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: newValue }),
          }
        );
      } else {
        await fetch(
          `https://api.vercel.com/v9/projects/${projectId}/env?teamId=${teamId}`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: 'TRIAGE_RULES', value: newValue, type: 'plain', target: ['production'] }),
          }
        );
      }

      return { rules, message: `Done. ${rules.length} active rule(s). Takes effect on the next morning digest.` };
    }

    case 'delete_draft': {
      await graph(token, `${base}/messages/${input.draft_id}`, 'DELETE');
      const candidate = await markDraftCandidateByDraftId(input.draft_id, 'dismissed');
      return { success: true, candidate, message: 'Draft deleted.' };
    }

    case 'update_digest_item_status': {
      return updateDigestItemStatus(threadTs, input.item_number, input.action_status);
    }

    case 'search_context_cards': {
      return searchContextCards(input);
    }

    case 'search_memory': {
      return searchMemory(input);
    }

    case 'search_memory_entities': {
      return searchMemoryEntities(input);
    }

    case 'search_thread_memory': {
      return searchThreadMemory(input);
    }

    case 'get_entity_context': {
      return getEntityContext(input);
    }

    case 'list_draft_response_candidates': {
      return listDraftResponseCandidates(input);
    }

    case 'list_forgotten_items': {
      return listForgottenItems(input);
    }

    case 'update_forgotten_item_status': {
      return updateForgottenItemStatus(input, threadTs);
    }

    case 'resolve_draft_response_candidate': {
      return resolveDraftResponseCandidate(input);
    }

    case 'record_draft_feedback': {
      return recordDraftFeedback(input);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function executeTool(name, input, token, threadTs) {
  try {
    const result = await executeToolInternal(name, input, token, threadTs);
    await logAgentAction({
      status: 'succeeded',
      toolName: name,
      slackThreadTs: threadTs,
      input,
      result,
    });
    return result;
  } catch (error) {
    await logAgentAction({
      status: 'failed',
      toolName: name,
      slackThreadTs: threadTs,
      input,
      errorMessage: error.message,
    });
    throw error;
  }
}

// --- Slack helpers ---

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function verifySlackSignature(rawBody, headers) {
  const timestamp = headers['x-slack-request-timestamp'];
  const signature = headers['x-slack-signature'];
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const hmac = crypto.createHmac('sha256', process.env.SLACK_SIGNING_SECRET);
  hmac.update(`v0:${timestamp}:${rawBody}`);
  const computed = `v0=${hmac.digest('hex')}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
  } catch {
    return false;
  }
}

async function slackPost(text, threadTs = null) {
  await fetch('https://slack.com/api/chat.postMessage', {
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
}

async function getThreadHistory(threadTs) {
  const res = await fetch(
    `https://slack.com/api/conversations.replies?channel=${CHANNEL_ID}&ts=${threadTs}&limit=20`,
    { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } }
  );
  const data = await res.json();
  return data.messages || [];
}

// --- Agentic loop ---

const SYSTEM_PROMPT = `You are an email assistant for Grant Carlson, Head of Operations at Milestone Properties (grant@milestoneproperties.net), a property management company in the Seattle/Burien/SeaTac area. Grant messages you in Slack. You have tools to read, search, and draft emails in his Outlook inbox.

RULES:
- NEVER send an email without Grant explicitly approving it (e.g. "send it", "looks good", "go ahead")
- If the current Slack thread contains a forgotten-items list, follow-up references like "#1", "#2", or "number 3" refer to that forgotten-items list unless Grant explicitly says digest item.
- When Grant refers to a numbered digest item like "#1", "#2", or "number 3", call resolve_digest_item first and use its message_id for any get_email or create_draft_reply call.
- When drafting a REPLY, you MUST first search for or retrieve the original email to get its message ID, then use create_draft_reply with that ID. Never use create_new_draft for a reply — this breaks email threading. Save the draft, show it in Slack, then ask: "Send it, edit it, or discard?"
- If Grant says a numbered digest item is done, waiting, dismissed, or has a draft prepared, call update_digest_item_status.
- When Grant says "discard", "delete the draft", or "never mind", use get_recent_drafts to find the draft ID, then use delete_draft to remove it.
- When showing a reply draft, always list who it's going To: and CC: (CC recipients from the original are included automatically)
- When Grant says "send it" in a thread, use get_recent_drafts to find the draft, then send_draft to send it
- If a thread message refers to earlier context (like "send it"), look at the conversation history provided
- When Grant says an email type should be higher or lower priority (e.g. "emails from X should be Action Required"), use update_triage_rules to save it — confirm the rule was saved and list all active rules
- For questions about prior context, latest status, open items, properties, property aliases, owners/investors, team members, real estate schedule/investment profile, vendors, insurance, financial statements, invoices, deadlines, projects, or "what happened with X", search_context_cards first. If cards are missing, thin, or source details are needed, then use search_memory. Then use search_memory_entities, search_thread_memory, or get_entity_context for narrower follow-up.
- When search_memory_entities returns a promising entity and Grant asks for details, call get_entity_context before answering.
- Treat sources differently: AppFolio is current property/tenant/accounting status; email is conversation history and promises; WhatsApp is informal work conversation history; Slack is team communication and approvals; Supabase is assistant memory/workflow state; GitHub is code source of truth; Vercel is deployed runtime/configuration state.
- When answering operational memory questions, use this short shape when it fits: what matters, who owns it, what happened last, what should happen next, and what evidence supports it.
- Use the trust fields returned by memory tools. If confidence is low or medium, say so briefly. If AppFolio or another source of truth has not been checked, say the answer is not verified there.
- Keep Slack replies short. Include only the most useful evidence inline; do not paste long source dumps unless Grant asks for detail.
- When answering from memory, mention the source email subject/sender/date when available and say when the stored memory is thin or based only on previews.
- When Grant asks "what am I forgetting?", "what slipped?", "what loose ends are there?", or similar, call list_forgotten_items first. Return the top 3-6 items as a numbered list, grouped lightly if helpful, with one concrete next action per item.
- When Grant follows up on a forgotten-items list with "done #2", "dismiss #3", "waiting on #4", "snooze #1", "make #5 priority", or similar, call update_forgotten_item_status. Resolve the number against the latest forgotten-items list in the Slack thread, not the morning digest.
- For forgotten-items feedback, confirm the update in one short sentence. Do not send emails or change AppFolio.
- Suggested draft replies should only be surfaced from list_draft_response_candidates, which is limited to known contacts with more than one prior back-and-forth exchange and emails that appear to seek a response.
- When Grant asks "what should I respond to?" or asks for draft suggestions, call list_draft_response_candidates first. For a chosen candidate, gather the email, thread, memory, contact/entity context, and prior draft_feedback before drafting.
- When Grant refers to a draft candidate by number, such as "candidate #1", "draft #1", or "first one", call resolve_draft_response_candidate first. Use its original email body, thread memory, and prior_feedback before drafting.
- Do not start a manual candidate triage or button-selection process unless Grant explicitly asks for it. Keep candidate lists lightweight.
- Draft suggestions are suggestions only. Save an Outlook draft only when Grant asks you to draft it or approves the suggested direction.
- When Grant corrects a draft or says the tone/content is wrong, call record_draft_feedback with the correction and a reusable guidance sentence before or while revising.

COMPANY CONTEXT:
- Uses AppFolio for property management, Grasshopper for texting
- Internal team: Rhoda (principal), Conor Murphy (accounting@milestoneproperties.net), Jamie Masterson (leasing), Kelsey Dempsey (property manager), Sabrina, Jeremy, Jeri
- External: Alpine CPAs (Josh), BECU lender (Crystal Li, Jawad Habibi), Psomas (Shannon Jensvold)

WRITING STYLE — write exactly as Grant would:

OVERALL VOICE:
- Professional, calm, direct, collaborative
- Plainspoken, low-ego, task-oriented, quietly confident
- Never use corporate jargon, legalistic phrasing, aggressive commands, overly long explanations, or flowery closings

STRUCTURE:
Opening: Brief, human, friendly — even in technical threads
- "Hi {Name},"
- "Hope you're doing well."
- "Hi {Name}, hope you're well."

Body:
- 1–2 sentences of brief context
- One clear request, question, or clarification
- Optional delegation or handoff
- Short paragraphs, prefer clarity over completeness
- Let the recipient infer urgency unless it's critical

Closing: Short and polite
- "Thanks," / "Thanks!" / "-Grant"
- No long signature blocks in replies
- For new external emails include: Grant Carlson | Milestone Properties | (C) 206-553-9098 (O) 206-775-7335

LANGUAGE:
Preferred phrases: "Hope you're doing well" / "When you have a chance" / "Could we" / "Do you mind" / "Happy to" / "Let me know" / "I'll let {Name} take it away"
Avoided phrases: "Per my last email" / "Kindly advise" / "At your earliest convenience" / "Sorry to bother you" / "If it's not too much trouble"

POLITENESS:
- Respectful without weakening the request
- Preferred: "Could we take a look at this?" / "When you have a moment, can you confirm?" / "Do you mind sharing the details?"
- Avoided: over-apologizing, deferential hedging

DELEGATION:
- Gentle and collaborative
- "I'll let {Name} take it away" / "{Name} had a couple questions for you" / "We've been taking a look at this and wanted your input"

INFORMALITY:
- Allowed only with known collaborators
- Never with legal counsel, lenders, or unfamiliar vendors
- Occasional single emoji (🙂) or light conversational aside is fine with familiar contacts

AUTHORITY:
- Implicit rather than directive
- Frame decisions as shared, ask for confirmation instead of issuing commands, delegate rather than instruct

Always write as Grant, in first person. Never explain what the email is doing — just write it.

FORMAT SLACK RESPONSES:
- *Bold* for email subjects/senders
- Bullet points for summaries
- Use \`\`\` code blocks for draft email text`;

async function runAgent(userMessage, threadTs, threadHistory = []) {
  const token = await getGraphToken();
  const anthropic = new Anthropic();

  // Build conversation context from thread history (so Claude knows about prior drafts, etc.)
  const messages = [];
  for (const msg of threadHistory) {
    if (msg.bot_id) {
      messages.push({ role: 'assistant', content: msg.text });
    } else if (msg.text !== userMessage) {
      messages.push({ role: 'user', content: msg.text });
    }
  }
  messages.push({ role: 'user', content: userMessage });

  while (true) {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: EMAIL_TOOLS,
      messages,
    });

    if (response.stop_reason === 'end_turn') {
      const text = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
      await slackPost(text, threadTs);
      break;
    }

    if (response.stop_reason === 'tool_use') {
      const toolUses = response.content.filter(b => b.type === 'tool_use');
      const results = [];

      for (const tu of toolUses) {
        try {
          const result = await executeTool(tu.name, tu.input, token, threadTs);
          results.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify(result),
          });
        } catch (err) {
          results.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: `Error: ${err.message}`,
            is_error: true,
          });
        }
      }

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: results });
    }
  }
}

// --- Main handler ---

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);
  if (!verifySlackSignature(rawBody, req.headers)) return res.status(401).end();

  const body = JSON.parse(rawBody);

  // Slack URL verification (one-time, when you first configure the endpoint)
  if (body.type === 'url_verification') return res.json({ challenge: body.challenge });

  const { event } = body;

  // Only handle real user messages in #inbox-digest
  if (
    body.type !== 'event_callback' ||
    event?.type !== 'message' ||
    event?.channel !== CHANNEL_ID ||
    event?.bot_id ||
    event?.subtype
  ) {
    return res.status(200).end();
  }

  // Acknowledge Slack immediately (required within 3s), then process in background.
  res.status(200).json({ ok: true });

  waitUntil(
    (async () => {
      const replyTs = event.thread_ts || event.ts;
      await slackPost('_On it..._', replyTs);
      const history = event.thread_ts
        ? await getThreadHistory(event.thread_ts)
        : [];
      await runAgent(event.text, replyTs, history);
    })().catch(async err => {
      console.error('Agent error:', err);
      await slackPost(`Something went wrong: ${err.message}`, event.ts);
    })
  );
}
