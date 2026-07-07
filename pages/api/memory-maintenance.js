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

function baseUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

async function callTask(req, task) {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl(req)}${task.path}`, {
    headers: {
      Authorization: `Bearer ${process.env.CRON_SECRET}`,
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 1000) };
  }

  return {
    name: task.name,
    path: task.path,
    ok: response.ok && body?.ok !== false,
    status: response.status,
    duration_ms: Date.now() - startedAt,
    body,
  };
}

const CONTEXT_CARD_TASK = { name: 'context_cards', path: '/api/backfill-context-cards?max_chunks=500&max_records=250' };

const TASKS = [
  { name: 'backfill_inbox', path: '/api/backfill-inbox?days=3&max=50' },
  { name: 'backfill_sent_mail', path: '/api/backfill-sent-mail?days=180&max=100' },
  { name: 'email_bodies', path: '/api/backfill-email-bodies?max=50' },
  { name: 'attachments', path: '/api/backfill-attachments?max=25' },
  { name: 'entities', path: '/api/backfill-entities?days=7&max=10' },
  { name: 'owner_investors', path: '/api/backfill-owner-investors?max=500' },
  { name: 'source_memory', path: '/api/backfill-source-memory?scope=all&properties=500&schedule=500' },
  { name: 'operational_memory', path: '/api/backfill-operational-memory?threads=5' },
  { name: 'draft_candidates', path: '/api/backfill-draft-candidates?days=14&history_days=365&max=50&history_max=2500&refresh=1' },
  CONTEXT_CARD_TASK,
  { name: 'missing_embeddings', path: '/api/backfill-memory-chunks?missing=50' },
];

function dayOfYear(date = new Date()) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.floor((today - start) / 86_400_000);
}

function selectedTasks(req) {
  if (req.query.all === '1') return TASKS;

  const requestedTask = req.query.task;
  if (requestedTask) {
    const task = TASKS.find(candidate => candidate.name === requestedTask);
    return task ? [task] : [];
  }

  return [TASKS[dayOfYear() % TASKS.length]];
}

function tasksForRun(req) {
  const tasks = selectedTasks(req);
  if (req.query.skip_context_cards === '1') return tasks;
  if (!tasks.length || tasks.some(task => task.name === CONTEXT_CARD_TASK.name)) return tasks;
  return [...tasks, CONTEXT_CARD_TASK];
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();
  if (!verifyCronRequest(req)) return res.status(401).json({ error: 'Unauthorized' });

  const tasks = tasksForRun(req);
  if (!tasks.length) {
    return res.status(400).json({
      ok: false,
      error: 'Unknown maintenance task.',
      available_tasks: TASKS.map(task => task.name),
    });
  }

  if (req.query.dry_run === '1') {
    return res.status(200).json({
      ok: true,
      dry_run: true,
      supabase_project_ref: projectRefFromUrl(),
      mode: req.query.all === '1' ? 'all' : (req.query.task ? 'single' : 'rotating_daily'),
      tasks,
      available_tasks: TASKS.map(task => task.name),
    });
  }

  const results = [];
  for (const task of tasks) {
    try {
      results.push(await callTask(req, task));
    } catch (error) {
      results.push({
        name: task.name,
        path: task.path,
        ok: false,
        status: null,
        duration_ms: null,
        error: error.message,
      });
    }
  }

  return res.status(200).json({
    ok: results.every(result => result.ok),
    supabase_project_ref: projectRefFromUrl(),
    mode: req.query.all === '1' ? 'all' : (req.query.task ? 'single' : 'rotating_daily'),
    results,
  });
}
