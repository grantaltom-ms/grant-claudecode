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
  'retrieval_logs'
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

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  if (!verifyCronRequest(req)) return res.status(401).json({ error: 'Unauthorized' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({
      error: 'Missing Supabase environment variables: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY'
    });
  }

  const tables = await Promise.all(TABLES.map(tableCount));

  return res.status(200).json({
    ok: true,
    supabase_project_ref: projectRefFromUrl(),
    tables
  });
}
