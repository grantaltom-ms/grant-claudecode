const baseUrl = process.env.INBOX_ASSISTANT_URL || 'https://inbox-assistant-one.vercel.app';
const cronSecret = process.env.CRON_SECRET;

if (!cronSecret) {
  console.error('CRON_SECRET is required.');
  process.exit(1);
}

const response = await fetch(`${baseUrl}/api/memory-status`, {
  headers: {
    Authorization: `Bearer ${cronSecret}`,
  },
});

const body = await response.json().catch(() => null);
if (!response.ok || !body?.ok) {
  console.error('Memory status failed:', response.status, body);
  process.exit(1);
}

const counts = Object.fromEntries(
  (body.tables || []).map(table => [table.table, table.count])
);

const requiredTables = [
  'email_messages',
  'email_threads',
  'memory_chunks',
  'email_attachments',
  'memory_projects',
  'open_loops'
];

for (const table of requiredTables) {
  if (!Number.isFinite(counts[table])) {
    console.error(`Missing count for ${table}`);
    process.exit(1);
  }
}

console.log(JSON.stringify({
  ok: true,
  supabase_project_ref: body.supabase_project_ref,
  counts,
  health: body.health,
}, null, 2));
