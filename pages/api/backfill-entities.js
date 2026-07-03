import Anthropic from '@anthropic-ai/sdk';
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

function safeError(error) {
  return {
    code: error?.code || null,
    message: error?.message || 'Unknown error',
    details: error?.details || null,
    hint: error?.hint || null
  };
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

async function loadMessages({ days, maxMessages }) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('email_messages')
    .select('graph_message_id,graph_conversation_id,subject,sender_name,sender_email,received_at,body_preview,importance,has_attachments')
    .eq('owner_email', OWNER_EMAIL)
    .gte('received_at', since)
    .order('received_at', { ascending: false })
    .limit(maxMessages);

  if (error) throw new Error(`Email memory lookup failed: ${error.message}`);
  return data || [];
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function extractEntityCandidatesBatch(anthropic, messages) {
  if (messages.length === 0) return [];

  const extractionInput = messages.map((message, index) => (
    `${index + 1}. graph_message_id: ${message.graph_message_id}\n` +
    `conversation_id: ${message.graph_conversation_id || ''}\n` +
    `from: ${message.sender_name || ''} <${message.sender_email || ''}>\n` +
    `subject: ${message.subject || ''}\n` +
    `importance: ${message.importance || ''}\n` +
    `has_attachments: ${message.has_attachments ?? ''}\n` +
    `preview: ${(message.body_preview || '').slice(0, 600)}`
  )).join('\n\n');

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2500,
    system: `Extract durable business entities from saved Outlook email previews for Grant Carlson at Milestone Properties.

Return ONLY a valid JSON array. Each item must have:
{
  "entity_type": "property" | "person" | "vendor" | "tenant" | "invoice" | "deadline" | "insurance" | "financial_statement" | "project" | "legal_issue" | "maintenance_issue" | "leasing_issue" | "system" | "other",
  "name": "specific entity name",
  "graph_message_id": "message id copied exactly from input",
  "graph_conversation_id": "conversation id copied exactly from input when present",
  "subject": "email subject",
  "context": "brief reason this entity matters",
  "confidence": 0.0
}

Be conservative but useful. Prefer specific property names, vendor/company names, tenant/person names, invoice/deadline references, insurance items, financial statement requests or reports, projects, and issue types that will help future retrieval.`,
    messages: [{
      role: 'user',
      content: `Extract at most 8 entities from these saved email previews. Return raw JSON only, with no markdown fences:\n\n${extractionInput}`,
    }],
  });

  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim();
  const parsed = parseJsonArray(text);
  if (!parsed) {
    throw new Error(`Entity extraction returned non-JSON output: ${text.slice(0, 500)}`);
  }

  return parsed;
}

async function extractEntityCandidates(anthropic, messages) {
  const allCandidates = [];
  for (const batch of chunkArray(messages, 4)) {
    const candidates = await extractEntityCandidatesBatch(anthropic, batch);
    allCandidates.push(...candidates);
  }
  return allCandidates;
}

async function saveEntityMention(entityCandidate) {
  const normalizedName = normalizeEntityName(entityCandidate.name);
  if (!entityCandidate.entity_type || !entityCandidate.name || !normalizedName) {
    return { saved: false, skipped: true, reason: 'missing entity_type/name' };
  }

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

  if (entityError) return { saved: false, error: safeError(entityError) };

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

  if (mentionError) return { saved: false, entity_id: entity.id, error: safeError(mentionError) };

  return { saved: true, entity_id: entity.id };
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).end();
  if (!verifyCronRequest(req)) return res.status(401).json({ error: 'Unauthorized' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({
      error: 'Missing Supabase environment variables: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY'
    });
  }

  try {
    const days = boundedInteger(req.query.days, 7, 30);
    const maxMessages = boundedInteger(req.query.max, 30, 100);
    const messages = await loadMessages({ days, maxMessages });
    const candidates = await extractEntityCandidates(new Anthropic(), messages);

    const saveResults = [];
    for (const candidate of candidates) {
      saveResults.push(await saveEntityMention(candidate));
    }

    const errors = saveResults
      .filter(result => result.error)
      .map(result => result.error);

    return res.status(200).json({
      ok: errors.length === 0,
      supabase_project_ref: projectRefFromUrl(),
      days,
      max_messages: maxMessages,
      messages_considered: messages.length,
      candidates_extracted: candidates.length,
      saved_mentions: saveResults.filter(result => result.saved).length,
      skipped: saveResults.filter(result => result.skipped).length,
      error_count: errors.length,
      errors: errors.slice(0, 10)
    });
  } catch (error) {
    console.error('Entity backfill failed:', error);
    return res.status(500).json({
      ok: false,
      supabase_project_ref: projectRefFromUrl(),
      error: error.message
    });
  }
}
