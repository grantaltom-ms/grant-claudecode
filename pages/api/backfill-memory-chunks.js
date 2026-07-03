import { createClient } from '@supabase/supabase-js';

const OWNER_EMAIL = 'grant@milestoneproperties.net';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
const EMAIL_BODY_CHUNK_SIZE = 2200;
const EMAIL_BODY_CHUNK_OVERLAP = 200;
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

function compactJson(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function truncateText(text, max = 6000) {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function chunkLongText(text, maxLength = EMAIL_BODY_CHUNK_SIZE, overlap = EMAIL_BODY_CHUNK_OVERLAP) {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [''];
  if (normalized.length <= maxLength) return [normalized];

  const chunks = [];
  let start = 0;
  while (start < normalized.length) {
    const targetEnd = Math.min(start + maxLength, normalized.length);
    let end = targetEnd;

    if (targetEnd < normalized.length) {
      const sentenceBreak = normalized.lastIndexOf('. ', targetEnd);
      const paragraphBreak = normalized.lastIndexOf('\n', targetEnd);
      const whitespaceBreak = normalized.lastIndexOf(' ', targetEnd);
      const naturalBreak = Math.max(sentenceBreak + 1, paragraphBreak, whitespaceBreak);
      if (naturalBreak > start + Math.floor(maxLength * 0.65)) end = naturalBreak;
    }

    chunks.push(normalized.slice(start, end).trim());
    if (end >= normalized.length) break;
    start = Math.max(0, end - overlap);
  }

  return chunks.filter(Boolean);
}

function embeddingToSqlVector(embedding) {
  return embedding?.length ? `[${embedding.join(',')}]` : null;
}

async function createEmbedding(text) {
  if (!process.env.OPENAI_API_KEY) return null;
  const input = truncateText(text, 7000);
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
    console.error('Embedding request failed:', {
      status: response.status,
      error: data?.error?.message || data,
    });
    return {
      embedding: null,
      error: data?.error?.message || `OpenAI embedding request failed with status ${response.status}`,
      status: response.status,
    };
  }

  return {
    embedding: data.data?.[0]?.embedding || null,
    error: null,
    status: response.status,
  };
}

async function upsertChunk(chunk) {
  const embeddingResult = await createEmbedding(`${chunk.title || ''}\n${chunk.chunk_summary || ''}\n${chunk.chunk_text || ''}`);
  const embedding = embeddingResult?.embedding || null;
  const now = new Date().toISOString();

  const { error } = await supabase
    .from('memory_chunks')
    .upsert({
      owner_email: OWNER_EMAIL,
      source_type: chunk.source_type,
      source_table: chunk.source_table,
      source_pk: chunk.source_pk,
      source_id: chunk.source_id || null,
      entity_id: chunk.entity_id || null,
      thread_id: chunk.thread_id || null,
      message_id: chunk.message_id || null,
      graph_message_id: chunk.graph_message_id || null,
      graph_conversation_id: chunk.graph_conversation_id || null,
      title: chunk.title || null,
      chunk_text: truncateText(chunk.chunk_text),
      chunk_summary: chunk.chunk_summary || null,
      metadata: chunk.metadata || {},
      embedding: embeddingToSqlVector(embedding),
      embedding_model: embedding ? EMBEDDING_MODEL : null,
      embedded_at: embedding ? now : null,
      updated_at: now,
    }, {
      onConflict: 'owner_email,source_type,source_pk'
    });

  if (error) return { ok: false, source_type: chunk.source_type, source_pk: chunk.source_pk, error };
  return {
    ok: true,
    embedded: Boolean(embedding),
    embedding_error: embeddingResult?.error || null,
    embedding_status: embeddingResult?.status || null,
  };
}

async function embedExistingChunk(chunk) {
  const embeddingResult = await createEmbedding(`${chunk.title || ''}\n${chunk.chunk_summary || ''}\n${chunk.chunk_text || ''}`);
  const embedding = embeddingResult?.embedding || null;
  if (!embedding) {
    return {
      ok: true,
      embedded: false,
      embedding_error: embeddingResult?.error || 'Embedding response did not include a vector.',
      embedding_status: embeddingResult?.status || null,
    };
  }

  const now = new Date().toISOString();
  const { error } = await supabase
    .from('memory_chunks')
    .update({
      embedding: embeddingToSqlVector(embedding),
      embedding_model: EMBEDDING_MODEL,
      embedded_at: now,
      updated_at: now,
    })
    .eq('id', chunk.id);

  if (error) return { ok: false, source_type: chunk.source_type, source_pk: chunk.source_pk, error };
  return { ok: true, embedded: true, embedding_error: null, embedding_status: embeddingResult?.status || null };
}

async function loadMissingEmbeddingChunks(limit) {
  const { data, error } = await supabase
    .from('memory_chunks')
    .select('id, source_type, source_pk, title, chunk_text, chunk_summary, created_at')
    .eq('owner_email', OWNER_EMAIL)
    .is('embedded_at', null)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Missing embedding chunk load failed: ${error.message}`);
  return data || [];
}

async function loadThreadChunks(limit) {
  const { data, error } = await supabase
    .from('email_threads')
    .select('id, graph_conversation_id, latest_subject, participant_emails, participant_names, first_message_at, last_message_at, message_count, current_summary, open_items, status, summary_updated_at, updated_at')
    .eq('owner_email', OWNER_EMAIL)
    .not('current_summary', 'is', null)
    .order('summary_updated_at', { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error) throw new Error(`Thread chunk load failed: ${error.message}`);

  return (data || []).map(thread => ({
    source_type: 'thread_summary',
    source_table: 'email_threads',
    source_pk: thread.id,
    source_id: thread.id,
    thread_id: thread.id,
    graph_conversation_id: thread.graph_conversation_id,
    title: thread.latest_subject || 'Email thread',
    chunk_summary: thread.current_summary,
    chunk_text: [
      `Subject: ${thread.latest_subject || ''}`,
      `Participants: ${[...(thread.participant_names || []), ...(thread.participant_emails || [])].join(', ')}`,
      `Status: ${thread.status || ''}`,
      `Open items: ${compactJson(thread.open_items)}`,
      `Summary: ${thread.current_summary || ''}`,
    ].join('\n'),
    metadata: {
      first_message_at: thread.first_message_at,
      last_message_at: thread.last_message_at,
      message_count: thread.message_count,
      summary_updated_at: thread.summary_updated_at,
    },
  }));
}

async function loadEntityChunks(limit) {
  const { data, error } = await supabase
    .from('entities')
    .select('id, entity_type, name, current_summary, metadata, first_seen_at, last_seen_at, updated_at')
    .eq('owner_email', OWNER_EMAIL)
    .order('last_seen_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Entity chunk load failed: ${error.message}`);

  return (data || []).map(entity => ({
    source_type: 'entity',
    source_table: 'entities',
    source_pk: entity.id,
    source_id: entity.id,
    entity_id: entity.id,
    title: `${entity.entity_type}: ${entity.name}`,
    chunk_summary: entity.current_summary || null,
    chunk_text: [
      `Entity type: ${entity.entity_type}`,
      `Name: ${entity.name}`,
      `Summary: ${entity.current_summary || ''}`,
      `Metadata: ${compactJson(entity.metadata)}`,
    ].join('\n'),
    metadata: {
      entity_type: entity.entity_type,
      first_seen_at: entity.first_seen_at,
      last_seen_at: entity.last_seen_at,
    },
  }));
}

async function loadEmailPreviewChunks(limit, offset = 0) {
  const { data, error } = await supabase
    .from('email_messages')
    .select('id, graph_message_id, graph_conversation_id, subject, sender_name, sender_email, received_at, body_preview, body_text, importance, has_attachments, updated_at')
    .eq('owner_email', OWNER_EMAIL)
    .order('received_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(`Email chunk load failed: ${error.message}`);

  return (data || []).flatMap(message => {
    const body = message.body_text || message.body_preview || '';
    const bodyChunks = message.body_text ? chunkLongText(body) : [body];
    const chunkCount = bodyChunks.length;

    return bodyChunks.map((bodyChunk, index) => ({
      source_type: message.body_text ? 'email_body' : 'email_preview',
      source_table: 'email_messages',
      source_pk: index === 0 ? message.id : `${message.id}:body:${index + 1}`,
      source_id: message.id,
      message_id: message.id,
      graph_message_id: message.graph_message_id,
      graph_conversation_id: message.graph_conversation_id,
      title: chunkCount > 1
        ? `${message.subject || 'Email'} (part ${index + 1}/${chunkCount})`
        : (message.subject || 'Email'),
      chunk_summary: message.body_preview || null,
      chunk_text: [
        `Subject: ${message.subject || ''}`,
        `From: ${message.sender_name || message.sender_email || ''} <${message.sender_email || ''}>`,
        `Received: ${message.received_at || ''}`,
        `Importance: ${message.importance || ''}`,
        `Has attachments: ${message.has_attachments ?? false}`,
        `Body part: ${index + 1} of ${chunkCount}`,
        `Body: ${bodyChunk}`,
      ].join('\n'),
      metadata: {
        received_at: message.received_at,
        has_attachments: message.has_attachments,
        body_source: message.body_text ? 'body_text' : 'body_preview',
        chunk_index: index + 1,
        chunk_count: chunkCount,
        body_char_count: body.length,
      },
    }));
  });
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
    const missingLimit = boundedInteger(req.query.missing, 0, 500);
    const scope = req.query.scope || 'all';
    const emailOffset = boundedInteger(req.query.email_offset, 0, 10000);
    const chunks = missingLimit > 0
      ? await loadMissingEmbeddingChunks(missingLimit)
      : [
        ...(scope === 'all' || scope === 'threads'
          ? await loadThreadChunks(boundedInteger(req.query.threads, 50, 500))
          : []),
        ...(scope === 'all' || scope === 'entities'
          ? await loadEntityChunks(boundedInteger(req.query.entities, 100, 1000))
          : []),
        ...(scope === 'all' || scope === 'emails'
          ? await loadEmailPreviewChunks(boundedInteger(req.query.emails, 50, 500), emailOffset)
          : []),
      ];

    const writeChunk = missingLimit > 0 ? embedExistingChunk : upsertChunk;

    let saved = 0;
    let embedded = 0;
    let embeddingFailures = 0;
    const errors = [];
    const embeddingErrors = [];
    for (const chunk of chunks) {
      const result = await writeChunk(chunk);
      if (result.ok) {
        saved += 1;
        if (result.embedded) embedded += 1;
        if (result.embedding_error) {
          embeddingFailures += 1;
          if (embeddingErrors.length < 5) {
            embeddingErrors.push({
              source_type: chunk.source_type,
              source_pk: chunk.source_pk,
              status: result.embedding_status,
              message: result.embedding_error,
            });
          }
        }
      } else {
        errors.push({
          source_type: result.source_type,
          source_pk: result.source_pk,
          message: result.error?.message,
          code: result.error?.code,
        });
      }
    }

    return res.status(200).json({
      ok: errors.length === 0,
      supabase_project_ref: projectRefFromUrl(),
      mode: missingLimit > 0 ? 'missing_embeddings' : 'source_rebuild',
      scope: missingLimit > 0 ? null : scope,
      email_offset: scope === 'all' || scope === 'emails' ? emailOffset : null,
      chunks_considered: chunks.length,
      saved_chunks: saved,
      embedded_chunks: embedded,
      embeddings_enabled: Boolean(process.env.OPENAI_API_KEY),
      embedding_failure_count: embeddingFailures,
      embedding_errors: embeddingErrors,
      error_count: errors.length,
      errors: errors.slice(0, 10),
    });
  } catch (error) {
    console.error('Memory chunk backfill failed:', error);
    return res.status(500).json({
      ok: false,
      supabase_project_ref: projectRefFromUrl(),
      error: error.message,
    });
  }
}
