import { createClient } from '@supabase/supabase-js';

const TABLES = [
  'email_messages',
  'email_threads',
  'digest_runs',
  'digest_items',
  'entities',
  'entity_mentions',
  'email_attachments',
  'memory_chunks',
  'retrieval_logs',
  'memory_projects',
  'decisions',
  'commitments',
  'open_loops',
  'agent_actions',
  'draft_response_candidates',
  'draft_feedback',
  'daily_priority_suggestions'
];

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

function safeError(error) {
  return {
    code: error?.code || null,
    message: error?.message || 'Unknown error',
    details: error?.details || null,
    hint: error?.hint || null
  };
}

async function tableCount(table) {
  const { count, error } = await supabase
    .from(table)
    .select('id', { count: 'exact', head: true });

  if (error) return { table, ok: false, error: safeError(error) };
  return { table, ok: true, count };
}

async function scalarStatus() {
  const [
    bodyCounts,
    attachmentCounts,
    chunkCounts,
    latestDigest,
    latestRetrieval,
    latestAgentAction,
    latestFailedAgentAction,
    draftCandidateCounts,
    ownerInvestorCounts,
    sourceMemoryCounts,
    latestDailyPriority,
    dailyPriorityCounts,
    latestOperationalCounts
  ] = await Promise.all([
    supabase
      .from('email_messages')
      .select('id, body_text, body_html', { count: 'exact' })
      .not('body_text', 'is', null),
    supabase
      .from('email_attachments')
      .select('id, content_text', { count: 'exact' })
      .not('content_text', 'is', null),
    supabase
      .from('memory_chunks')
      .select('id, embedding', { count: 'exact' })
      .not('embedding', 'is', null),
    supabase
      .from('digest_runs')
      .select('run_started_at, run_completed_at, total_emails, saved_emails, included_count, archived_count, status, metadata')
      .order('run_started_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('retrieval_logs')
      .select('created_at, query, tool_name, result_count, used_embedding, metadata')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('agent_actions')
      .select('created_at, action_type, status, tool_name, slack_thread_ts, graph_message_id, graph_conversation_id, error_message')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('agent_actions')
      .select('created_at, action_type, status, tool_name, slack_thread_ts, error_message')
      .eq('status', 'failed')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    Promise.all([
      supabase.from('draft_response_candidates').select('id', { count: 'exact', head: true }).eq('status', 'candidate'),
      supabase.from('draft_response_candidates').select('id', { count: 'exact', head: true }).eq('status', 'drafted'),
      supabase.from('draft_feedback').select('id', { count: 'exact', head: true }),
    ]),
    Promise.all([
      supabase
        .from('entities')
        .select('id', { count: 'exact', head: true })
        .eq('entity_type', 'person')
        .contains('metadata', { role: 'owner_investor' }),
      supabase
        .from('memory_chunks')
        .select('id', { count: 'exact', head: true })
        .eq('source_type', 'owner_investor'),
    ]),
    Promise.all([
      supabase.from('memory_chunks').select('id', { count: 'exact', head: true }).eq('source_type', 'property_profile'),
      supabase.from('memory_chunks').select('id', { count: 'exact', head: true }).eq('source_type', 'team_member'),
      supabase.from('memory_chunks').select('id', { count: 'exact', head: true }).eq('source_type', 'agent_context'),
      supabase.from('memory_chunks').select('id', { count: 'exact', head: true }).eq('source_type', 'real_estate_schedule'),
    ]),
    supabase
      .from('daily_priority_suggestions')
      .select('suggestion_date, status, title, activity, slack_message_ts, created_at')
      .eq('owner_email', 'grant@milestoneproperties.net')
      .order('suggestion_date', { ascending: false })
      .limit(1)
      .maybeSingle(),
    Promise.all([
      supabase.from('daily_priority_suggestions').select('id', { count: 'exact', head: true }),
      supabase.from('daily_priority_suggestions').select('id', { count: 'exact', head: true }).eq('status', 'suggested'),
    ]),
    Promise.all([
      supabase.from('memory_projects').select('id', { count: 'exact', head: true }),
      supabase.from('decisions').select('id', { count: 'exact', head: true }),
      supabase.from('commitments').select('id', { count: 'exact', head: true }).eq('status', 'open'),
      supabase.from('open_loops').select('id', { count: 'exact', head: true }).in('status', ['open', 'waiting']),
    ])
  ]);

  return {
    embeddings_enabled: Boolean(process.env.OPENAI_API_KEY),
    auto_archive_spam: process.env.AUTO_ARCHIVE_SPAM === 'true',
    messages_with_body_text: bodyCounts.count || 0,
    attachments_with_text: attachmentCounts.count || 0,
    embedded_memory_chunks: chunkCounts.count || 0,
    latest_digest: latestDigest.data || null,
    latest_retrieval: latestRetrieval.data || null,
    latest_agent_action: latestAgentAction.data || null,
    latest_failed_agent_action: latestFailedAgentAction.data || null,
    draft_responses: {
      candidates: draftCandidateCounts[0].count || 0,
      drafted: draftCandidateCounts[1].count || 0,
      feedback_items: draftCandidateCounts[2].count || 0,
    },
    owner_investor_memory: {
      entities: ownerInvestorCounts[0].count || 0,
      chunks: ownerInvestorCounts[1].count || 0,
    },
    source_memory: {
      property_profiles: sourceMemoryCounts[0].count || 0,
      team_members: sourceMemoryCounts[1].count || 0,
      agent_context: sourceMemoryCounts[2].count || 0,
      real_estate_schedule: sourceMemoryCounts[3].count || 0,
    },
    daily_priority: {
      suggestions: dailyPriorityCounts[0].count || 0,
      active_suggestions: dailyPriorityCounts[1].count || 0,
      latest: latestDailyPriority.data || null,
    },
    operational_memory: {
      projects: latestOperationalCounts[0].count || 0,
      decisions: latestOperationalCounts[1].count || 0,
      open_commitments: latestOperationalCounts[2].count || 0,
      open_loops: latestOperationalCounts[3].count || 0,
    }
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  if (!verifyCronRequest(req)) return res.status(401).json({ error: 'Unauthorized' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({
      error: 'Missing Supabase environment variables: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY'
    });
  }

  const [tables, health] = await Promise.all([
    Promise.all(TABLES.map(tableCount)),
    scalarStatus()
  ]);

  return res.status(200).json({
    ok: true,
    supabase_project_ref: projectRefFromUrl(),
    tables,
    health
  });
}
