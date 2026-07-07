import { createClient } from '@supabase/supabase-js';

const OWNER_EMAIL = 'grant@milestoneproperties.net';
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CHUNK_CARD_TYPES = {
  property_profile: 'property',
  real_estate_schedule: 'investment_profile',
  owner_investor: 'owner_investor',
  team_member: 'team_member',
  agent_context: 'operating_context',
  draft_feedback: 'draft_feedback',
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

function boundedInteger(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9@._:-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 180);
}

function cleanText(value, max = 1600) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function isMissingTableError(error) {
  return error?.code === '42P01'
    || error?.code === 'PGRST205'
    || /could not find the table|relation .* does not exist/i.test(error?.message || '');
}

function compactValue(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return cleanText(value, 700);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(item => compactValue(item, depth + 1));
  if (depth >= 2) return '[object]';

  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 30)
      .map(([key, item]) => [key, compactValue(item, depth + 1)])
  );
}

function cardImportance(status, priority) {
  if (priority === 'high') return 'high';
  if (['open', 'waiting', 'active'].includes(status)) return 'normal';
  return 'low';
}

async function upsertCard(card) {
  if (!card.card_key || !card.title || !card.summary) return null;

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('context_cards')
    .upsert({
      owner_email: OWNER_EMAIL,
      card_type: card.card_type,
      card_key: card.card_key,
      title: cleanText(card.title, 240),
      summary: cleanText(card.summary, 1800),
      facts: compactValue(card.facts || {}),
      source_refs: compactValue(card.source_refs || []),
      related_entity_id: card.related_entity_id || null,
      status: card.status || 'active',
      importance: card.importance || 'normal',
      last_seen_at: card.last_seen_at || now,
      source_updated_at: card.source_updated_at || null,
      updated_at: now,
    }, {
      onConflict: 'owner_email,card_type,card_key',
    })
    .select('id, card_type')
    .single();

  if (error) throw new Error(`Context card upsert failed for ${card.card_type}:${card.card_key}: ${error.message}`);
  return data;
}

async function hasContextCardTable() {
  const { error } = await supabase
    .from('context_cards')
    .select('id', { count: 'exact', head: true });

  if (!error) return true;
  if (isMissingTableError(error)) return false;
  throw new Error(`Context card table check failed: ${error.message}`);
}

function cardFromChunk(chunk) {
  const cardType = CHUNK_CARD_TYPES[chunk.source_type];
  if (!cardType) return null;

  return {
    card_type: cardType,
    card_key: normalizeKey(`${chunk.source_type}:${chunk.source_pk || chunk.id}`),
    title: chunk.title || `${cardType}: ${chunk.source_pk}`,
    summary: chunk.chunk_summary || chunk.chunk_text,
    facts: {
      source_type: chunk.source_type,
      source_table: chunk.source_table,
      source_pk: chunk.source_pk,
      metadata: chunk.metadata || {},
    },
    source_refs: [{
      table: chunk.source_table || 'memory_chunks',
      pk: chunk.source_pk || chunk.id,
      memory_chunk_id: chunk.id,
      source_type: chunk.source_type,
    }],
    related_entity_id: chunk.entity_id || null,
    status: 'active',
    importance: ['owner_investor', 'investment_profile'].includes(cardType) ? 'normal' : 'low',
    last_seen_at: chunk.updated_at || chunk.created_at,
    source_updated_at: chunk.updated_at || chunk.created_at,
  };
}

function cardFromProject(project) {
  return {
    card_type: 'project',
    card_key: normalizeKey(project.id),
    title: `Project: ${project.name}`,
    summary: project.summary || `${project.name} is a ${project.status || 'active'} project.`,
    facts: {
      status: project.status,
      metadata: project.metadata || {},
    },
    source_refs: [{ table: 'memory_projects', pk: project.id }],
    related_entity_id: project.related_entity_id || null,
    status: project.status || 'active',
    importance: cardImportance(project.status),
    last_seen_at: project.last_seen_at || project.updated_at,
    source_updated_at: project.updated_at,
  };
}

function cardFromDecision(decision) {
  return {
    card_type: 'decision',
    card_key: normalizeKey(decision.id),
    title: `Decision: ${decision.title}`,
    summary: decision.decision,
    facts: {
      status: decision.status,
      decided_at: decision.decided_at,
      metadata: decision.metadata || {},
    },
    source_refs: [{ table: 'decisions', pk: decision.id }],
    related_entity_id: decision.related_entity_id || null,
    status: decision.status || 'active',
    importance: cardImportance(decision.status),
    last_seen_at: decision.updated_at || decision.created_at,
    source_updated_at: decision.updated_at,
  };
}

function cardFromCommitment(commitment) {
  return {
    card_type: 'commitment',
    card_key: normalizeKey(commitment.id),
    title: `Commitment: ${commitment.title}`,
    summary: commitment.commitment,
    facts: {
      owner_name: commitment.owner_name,
      due_at: commitment.due_at,
      status: commitment.status,
      metadata: commitment.metadata || {},
    },
    source_refs: [{ table: 'commitments', pk: commitment.id }],
    related_entity_id: commitment.related_entity_id || null,
    status: commitment.status || 'open',
    importance: cardImportance(commitment.status),
    last_seen_at: commitment.updated_at || commitment.created_at,
    source_updated_at: commitment.updated_at,
  };
}

function cardFromOpenLoop(loop) {
  return {
    card_type: 'open_loop',
    card_key: normalizeKey(loop.id),
    title: `Open loop: ${loop.title}`,
    summary: loop.description || loop.title,
    facts: {
      priority: loop.priority,
      due_at: loop.due_at,
      status: loop.status,
      metadata: loop.metadata || {},
    },
    source_refs: [{ table: 'open_loops', pk: loop.id }],
    related_entity_id: loop.related_entity_id || null,
    status: loop.status || 'open',
    importance: cardImportance(loop.status, loop.priority),
    last_seen_at: loop.updated_at || loop.created_at,
    source_updated_at: loop.updated_at,
  };
}

function organizationCard({ latestDigest, latestPriority, counts }) {
  const summaryParts = [
    `Current memory has ${counts.open_loops || 0} open loops, ${counts.commitments || 0} open commitments, ${counts.projects || 0} tracked projects, and ${counts.draft_candidates || 0} active draft response candidates.`,
    latestDigest ? `Latest digest included ${latestDigest.included_count || 0} items and completed with status ${latestDigest.status}.` : null,
    latestPriority ? `Latest One Priority: ${latestPriority.title} (${latestPriority.suggestion_date}).` : null,
  ].filter(Boolean);

  return {
    card_type: 'organization',
    card_key: 'milestone-operating-snapshot',
    title: 'Milestone operating snapshot',
    summary: summaryParts.join(' '),
    facts: {
      counts,
      latest_digest: latestDigest,
      latest_priority: latestPriority,
    },
    source_refs: [
      { table: 'digest_runs', pk: latestDigest?.id || null },
      { table: 'daily_priority_suggestions', pk: latestPriority?.id || null },
    ].filter(ref => ref.pk),
    status: 'active',
    importance: 'normal',
    last_seen_at: new Date().toISOString(),
    source_updated_at: new Date().toISOString(),
  };
}

async function loadSourceData({ maxChunks, maxRecords }) {
  const [
    chunks,
    projects,
    decisions,
    commitments,
    openLoops,
    latestDigest,
    latestPriority,
    counts,
  ] = await Promise.all([
    supabase
      .from('memory_chunks')
      .select('id, source_type, source_table, source_pk, entity_id, title, chunk_summary, chunk_text, metadata, created_at, updated_at')
      .eq('owner_email', OWNER_EMAIL)
      .in('source_type', Object.keys(CHUNK_CARD_TYPES))
      .order('updated_at', { ascending: false })
      .limit(maxChunks),
    supabase
      .from('memory_projects')
      .select('id, name, status, summary, related_entity_id, metadata, last_seen_at, updated_at')
      .eq('owner_email', OWNER_EMAIL)
      .order('last_seen_at', { ascending: false })
      .limit(maxRecords),
    supabase
      .from('decisions')
      .select('id, title, decision, status, decided_at, related_entity_id, metadata, created_at, updated_at')
      .eq('owner_email', OWNER_EMAIL)
      .order('updated_at', { ascending: false })
      .limit(maxRecords),
    supabase
      .from('commitments')
      .select('id, title, commitment, owner_name, due_at, status, related_entity_id, metadata, created_at, updated_at')
      .eq('owner_email', OWNER_EMAIL)
      .in('status', ['open', 'waiting'])
      .order('updated_at', { ascending: false })
      .limit(maxRecords),
    supabase
      .from('open_loops')
      .select('id, title, description, priority, due_at, status, related_entity_id, metadata, created_at, updated_at')
      .eq('owner_email', OWNER_EMAIL)
      .in('status', ['open', 'waiting'])
      .order('updated_at', { ascending: false })
      .limit(maxRecords),
    supabase
      .from('digest_runs')
      .select('id, run_completed_at, included_count, status, metadata')
      .eq('owner_email', OWNER_EMAIL)
      .order('run_started_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('daily_priority_suggestions')
      .select('id, suggestion_date, title, activity, status, created_at')
      .eq('owner_email', OWNER_EMAIL)
      .order('suggestion_date', { ascending: false })
      .limit(1)
      .maybeSingle(),
    Promise.all([
      supabase.from('open_loops').select('id', { count: 'exact', head: true }).eq('owner_email', OWNER_EMAIL).in('status', ['open', 'waiting']),
      supabase.from('commitments').select('id', { count: 'exact', head: true }).eq('owner_email', OWNER_EMAIL).in('status', ['open', 'waiting']),
      supabase.from('memory_projects').select('id', { count: 'exact', head: true }).eq('owner_email', OWNER_EMAIL).in('status', ['active', 'waiting', 'stale']),
      supabase.from('draft_response_candidates').select('id', { count: 'exact', head: true }).eq('owner_email', OWNER_EMAIL).eq('status', 'candidate'),
    ]),
  ]);

  const errors = [
    chunks.error,
    projects.error,
    decisions.error,
    commitments.error,
    openLoops.error,
    latestDigest.error,
    latestPriority.error,
    ...counts.map(result => result.error),
  ].filter(Boolean);

  if (errors.length) throw new Error(`Context card source load failed: ${errors[0].message}`);

  return {
    chunks: chunks.data || [],
    projects: projects.data || [],
    decisions: decisions.data || [],
    commitments: commitments.data || [],
    openLoops: openLoops.data || [],
    latestDigest: latestDigest.data || null,
    latestPriority: latestPriority.data || null,
    counts: {
      open_loops: counts[0].count || 0,
      commitments: counts[1].count || 0,
      projects: counts[2].count || 0,
      draft_candidates: counts[3].count || 0,
    },
  };
}

function countByType(cards) {
  return cards.reduce((acc, card) => {
    acc[card.card_type] = (acc[card.card_type] || 0) + 1;
    return acc;
  }, {});
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).end();
  if (!verifyCronRequest(req)) return res.status(401).json({ error: 'Unauthorized' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({
      ok: false,
      error: 'Missing Supabase environment variables.',
    });
  }

  try {
    const tableExists = await hasContextCardTable();
    if (!tableExists) {
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: 'context_cards_table_missing',
        supabase_project_ref: projectRefFromUrl(),
      });
    }

    const maxChunks = boundedInteger(req.query.max_chunks, 400, 1000);
    const maxRecords = boundedInteger(req.query.max_records, 200, 500);
    const data = await loadSourceData({ maxChunks, maxRecords });
    const cards = [
      ...data.chunks.map(cardFromChunk).filter(Boolean),
      ...data.projects.map(cardFromProject),
      ...data.decisions.map(cardFromDecision),
      ...data.commitments.map(cardFromCommitment),
      ...data.openLoops.map(cardFromOpenLoop),
      organizationCard(data),
    ].filter(card => card.summary);

    const counts = { cards_considered: cards.length, cards_saved: 0, by_type: countByType(cards) };
    const errors = [];

    for (const card of cards) {
      try {
        const saved = await upsertCard(card);
        if (saved) counts.cards_saved += 1;
      } catch (error) {
        errors.push({
          card_type: card.card_type,
          card_key: card.card_key,
          title: card.title,
          message: error.message,
        });
      }
    }

    return res.status(200).json({
      ok: errors.length === 0,
      supabase_project_ref: projectRefFromUrl(),
      counts,
      error_count: errors.length,
      errors: errors.slice(0, 10),
    });
  } catch (error) {
    console.error('Context card backfill failed:', error);
    return res.status(500).json({
      ok: false,
      supabase_project_ref: projectRefFromUrl(),
      error: error.message,
    });
  }
}
