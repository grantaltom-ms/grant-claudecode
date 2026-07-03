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

function normalizeName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function sanitizeText(value) {
  if (value == null) return null;
  return String(value)
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

async function loadThreadSummaries(limit) {
  const { data, error } = await supabase
    .from('email_threads')
    .select('id, graph_conversation_id, latest_subject, participant_names, participant_emails, current_summary, open_items, status, summary_updated_at, last_message_at')
    .eq('owner_email', OWNER_EMAIL)
    .not('current_summary', 'is', null)
    .order('summary_updated_at', { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error) throw new Error(`Thread summary lookup failed: ${error.message}`);
  return data || [];
}

async function extractOperationalMemory(anthropic, threads) {
  const input = threads.map((thread, index) => (
    `${index}. source_index: ${index}\n` +
    `subject: ${thread.latest_subject || ''}\n` +
    `status: ${thread.status || ''}\n` +
    `participants: ${[...(thread.participant_names || []), ...(thread.participant_emails || [])].join(', ')}\n` +
    `summary: ${thread.current_summary || ''}\n` +
    `open_items: ${JSON.stringify(thread.open_items || [])}`
  )).join('\n\n');

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 3500,
    system: `Extract durable operating memory from email thread summaries for Grant Carlson at Milestone Properties.

Return ONLY valid JSON:
{
  "projects": [{"source_index": 0, "name": "", "summary": "", "status": "active|waiting|done|stale"}],
  "decisions": [{"source_index": 0, "title": "", "decision": "", "status": "active|superseded"}],
  "commitments": [{"source_index": 0, "title": "", "commitment": "", "owner_name": "", "due_at": null, "status": "open|waiting|done"}],
  "open_loops": [{"source_index": 0, "title": "", "description": "", "priority": "low|normal|high", "due_at": null, "status": "open|waiting"}]
}

Be conservative. Extract only useful durable records, not every minor email. source_index must refer to the provided thread index.`,
    messages: [{
      role: 'user',
      content: `Extract operating memory from these thread summaries:\n\n${input}`,
    }],
  });

  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim();
  const parsed = parseJsonObject(text);
  if (!parsed) throw new Error(`Operational memory extraction returned non-JSON output: ${text.slice(0, 500)}`);
  return parsed;
}

function sourceThread(threads, item) {
  const index = Number(item.source_index);
  return Number.isInteger(index) ? threads[index] : null;
}

async function upsertProject(item, thread) {
  const name = sanitizeText(item.name);
  if (!name) return null;

  const { data, error } = await supabase
    .from('memory_projects')
    .upsert({
      owner_email: OWNER_EMAIL,
      name,
      normalized_name: normalizeName(name),
      status: ['active', 'waiting', 'done', 'stale'].includes(item.status) ? item.status : 'active',
      summary: sanitizeText(item.summary),
      last_seen_at: new Date().toISOString(),
      metadata: {
        graph_conversation_id: thread?.graph_conversation_id || null,
        source_subject: thread?.latest_subject || null,
      },
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'owner_email,normalized_name'
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function upsertRecord(table, item, thread, fields) {
  const title = sanitizeText(item.title);
  if (!title || !thread?.id) return null;

  const { data, error } = await supabase
    .from(table)
    .upsert({
      owner_email: OWNER_EMAIL,
      title,
      source_thread_id: thread.id,
      metadata: {
        graph_conversation_id: thread.graph_conversation_id,
        source_subject: thread.latest_subject,
      },
      updated_at: new Date().toISOString(),
      ...fields,
    }, {
      onConflict: 'owner_email,title,source_thread_id'
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function upsertChunk({ sourceType, sourceTable, record, thread, text }) {
  if (!record?.id) return null;

  const { error } = await supabase
    .from('memory_chunks')
    .upsert({
      owner_email: OWNER_EMAIL,
      source_type: sourceType,
      source_table: sourceTable,
      source_pk: record.id,
      source_id: record.id,
      thread_id: thread?.id || null,
      graph_conversation_id: thread?.graph_conversation_id || null,
      title: record.title || record.name || sourceType,
      chunk_text: text,
      chunk_summary: record.summary || record.description || record.decision || record.commitment || null,
      metadata: {
        source_subject: thread?.latest_subject || null,
      },
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'owner_email,source_type,source_pk'
    });

  if (error) throw error;
  return true;
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).end();
  if (!verifyCronRequest(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const limit = boundedInteger(req.query.threads, 20, 50);
    const threads = await loadThreadSummaries(limit);
    const extracted = await extractOperationalMemory(new Anthropic(), threads);

    const counts = {
      projects: 0,
      decisions: 0,
      commitments: 0,
      open_loops: 0,
      chunks: 0,
    };
    const errors = [];

    for (const item of extracted.projects || []) {
      try {
        const thread = sourceThread(threads, item);
        const record = await upsertProject(item, thread);
        if (record) {
          counts.projects += 1;
          await upsertChunk({
            sourceType: 'project',
            sourceTable: 'memory_projects',
            record,
            thread,
            text: `Project: ${record.name}\nStatus: ${record.status}\nSummary: ${record.summary || ''}`,
          });
          counts.chunks += 1;
        }
      } catch (error) {
        errors.push({ type: 'project', message: error.message });
      }
    }

    for (const item of extracted.decisions || []) {
      try {
        const thread = sourceThread(threads, item);
        const record = await upsertRecord('decisions', item, thread, {
          decision: sanitizeText(item.decision),
          status: item.status === 'superseded' ? 'superseded' : 'active',
        });
        if (record) {
          counts.decisions += 1;
          await upsertChunk({
            sourceType: 'decision',
            sourceTable: 'decisions',
            record,
            thread,
            text: `Decision: ${record.title}\nStatus: ${record.status}\n${record.decision}`,
          });
          counts.chunks += 1;
        }
      } catch (error) {
        errors.push({ type: 'decision', message: error.message });
      }
    }

    for (const item of extracted.commitments || []) {
      try {
        const thread = sourceThread(threads, item);
        const record = await upsertRecord('commitments', item, thread, {
          commitment: sanitizeText(item.commitment),
          owner_name: sanitizeText(item.owner_name),
          due_at: item.due_at || null,
          status: ['open', 'waiting', 'done'].includes(item.status) ? item.status : 'open',
        });
        if (record) {
          counts.commitments += 1;
          await upsertChunk({
            sourceType: 'commitment',
            sourceTable: 'commitments',
            record,
            thread,
            text: `Commitment: ${record.title}\nOwner: ${record.owner_name || ''}\nDue: ${record.due_at || ''}\nStatus: ${record.status}\n${record.commitment}`,
          });
          counts.chunks += 1;
        }
      } catch (error) {
        errors.push({ type: 'commitment', message: error.message });
      }
    }

    for (const item of extracted.open_loops || []) {
      try {
        const thread = sourceThread(threads, item);
        const record = await upsertRecord('open_loops', item, thread, {
          description: sanitizeText(item.description),
          priority: ['low', 'normal', 'high'].includes(item.priority) ? item.priority : 'normal',
          due_at: item.due_at || null,
          status: ['open', 'waiting'].includes(item.status) ? item.status : 'open',
        });
        if (record) {
          counts.open_loops += 1;
          await upsertChunk({
            sourceType: 'open_loop',
            sourceTable: 'open_loops',
            record,
            thread,
            text: `Open loop: ${record.title}\nPriority: ${record.priority}\nDue: ${record.due_at || ''}\nStatus: ${record.status}\n${record.description || ''}`,
          });
          counts.chunks += 1;
        }
      } catch (error) {
        errors.push({ type: 'open_loop', message: error.message });
      }
    }

    return res.status(200).json({
      ok: errors.length === 0,
      supabase_project_ref: projectRefFromUrl(),
      threads_considered: threads.length,
      counts,
      error_count: errors.length,
      errors: errors.slice(0, 10),
    });
  } catch (error) {
    console.error('Operational memory backfill failed:', error);
    return res.status(500).json({
      ok: false,
      supabase_project_ref: projectRefFromUrl(),
      error: error.message,
    });
  }
}
