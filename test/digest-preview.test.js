import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import { graphSentItemsHandler } from './mocks/handlers';
import digestHandler, { runDigest } from '../pages/api/digest';
import { formatPreview } from '../lib/digest-preview';

// The preview (/api/digest?preview=1) runs the whole digest on real mail but
// must change NOTHING. Everything outside the code under test is mocked, and
// every write to every outside service is recorded so a test can say "none".

const GRANT = 'grant@milestoneproperties.net';
const SUPABASE = 'https://test-project.supabase.co/rest/v1';
const GRAPH = 'https://graph.microsoft.com/v1.0/users/:email';
const HOUR = 3_600_000;
const ARRIVED_AT = new Date(Date.now() - 2 * HOUR).toISOString();

const person = (address, name = '') => ({ emailAddress: { address, name } });
function mail({ id, name, address, subject, preview = `Preview for ${subject}`, conv = `conv-${id}`, headers }) {
  return {
    id,
    conversationId: conv,
    internetMessageId: `<${id}@example.com>`,
    subject,
    from: person(address, name),
    toRecipients: [person(GRANT, 'Grant Carlson')],
    ccRecipients: [],
    receivedDateTime: ARRIVED_AT,
    sentDateTime: ARRIVED_AT,
    isRead: false,
    hasAttachments: false,
    importance: 'normal',
    bodyPreview: preview,
    body: { contentType: 'text', content: preview },
    internetMessageHeaders: [{ name: 'Authentication-Results', value: headers || 'spf=pass; dkim=pass; dmarc=pass' }],
  };
}

// 0 Alice (action), 1 Rhoda (must-show), 2 work order, 3 replied thread, 4 spam, 5 Carol (FYI)
const EMAILS = [
  mail({ id: 'a1', name: 'Alice Anders', address: 'alice@a.example', subject: 'Roof quote' }),
  mail({ id: 'a2', name: 'Rhoda Altom', address: 'rhoda@milestoneproperties.net', subject: 'Family dinner' }),
  mail({ id: 'a3', name: 'AppFolio', address: 'noreply@appfolio.com', subject: 'Work Order #7 completed' }),
  mail({ id: 'a4', name: 'Pat Perez', address: 'pat@p.example', subject: 'Parking permit question', conv: 'conv-pat' }),
  mail({ id: 'a5', name: 'Spammy', address: 'spam@s.example', subject: 'Buy now' }),
  mail({ id: 'a6', name: 'Carol Chen', address: 'carol@c.example', subject: 'Parking signs' }),
];
// After the drops the model sees: #1 Alice, #2 Rhoda, #3 Carol.
const TRIAGE = '*🔴 Action Required*\n- [#1] Alice Anders — Roof quote: approve the bid\n\n*🟡 FYI / Needs Awareness*\n- [#3] Carol Chen — Parking signs: new signs ordered';

const reply = (text) => HttpResponse.json({
  id: 'm', type: 'message', role: 'assistant',
  content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text }],
  stop_reason: 'end_turn',
});

function setup({ emails = EMAILS, triage = TRIAGE, spamIndices = [4], lastCoverageEnd = null, deltaBootstrapped = false } = {}) {
  const seen = { writes: [], reads: [], posts: [], claude: [], inboxUrls: [] };
  const record = (request) => seen.writes.push(`${request.method} ${new URL(request.url).pathname}`);
  server.use(
    // Anything that changes something outside is recorded (these come first, so
    // they win over the shared catch-alls that would silently accept it).
    http.post('https://slack.com/api/chat.postMessage', async ({ request }) => {
      const body = await request.json();
      seen.posts.push(body);
      return HttpResponse.json({ ok: true, ts: `${1700000000 + seen.posts.length}.000001` });
    }),
    graphSentItemsHandler({ 'conv-pat': [new Date(Date.parse(ARRIVED_AT) + 600_000).toISOString()] }),
    http.get(`${GRAPH}/mailFolders/Inbox/messages`, ({ request }) => {
      seen.inboxUrls.push(new URL(request.url));
      return HttpResponse.json({ value: emails });
    }),
    http.get(`${SUPABASE}/inbox_delta_state`, () => {
      seen.reads.push('inbox_delta_state');
      return HttpResponse.json(deltaBootstrapped ? [{ cursor_url: 'https://graph.microsoft.com/v1.0/delta-cursor', is_bootstrapped: true }] : []);
    }),
    http.get(`${SUPABASE}/digest_runs`, () =>
      HttpResponse.json(lastCoverageEnd ? [{ metadata: { coverage_end: lastCoverageEnd } }] : [])
    ),
    http.post(`${SUPABASE}/digest_runs`, ({ request }) => { record(request); return HttpResponse.json({ id: 'run-1' }); }),
    http.post(`${SUPABASE}/digest_items`, async ({ request }) => {
      record(request);
      const rows = await request.json();
      return HttpResponse.json(rows.map((row) => ({ id: `item-${row.item_number}`, ...row })));
    }),
    http.post(`${GRAPH}/messages/:id/move`, ({ request }) => { record(request); return HttpResponse.json({ id: 'moved' }); }),
    http.post(`${GRAPH}/messages/:id/createReply`, ({ request }) => { record(request); return HttpResponse.json({ id: 'draft' }); }),
    http.delete(`${GRAPH}/messages/:id`, ({ request }) => { record(request); return new HttpResponse(null, { status: 204 }); }),
    http.post('https://api.anthropic.com/v1/messages', async ({ request }) => {
      const body = await request.json();
      const system = typeof body.system === 'string' ? body.system : (body.system?.[0]?.text || '');
      if (system.includes('spam filter')) { seen.claude.push('spam'); return reply(JSON.stringify(spamIndices)); }
      if (system.includes('Extract durable business entities')) { seen.claude.push('entities'); return reply('[]'); }
      if (system.includes('summarize business email threads')) { seen.claude.push('summaries'); return reply(JSON.stringify({ current_summary: 's', open_items: [], status: 'active' })); }
      if (system.includes('morning email triage assistant')) { seen.claude.push('triage'); return reply(triage); }
      seen.claude.push('other');
      return reply('[]'); // the auto-filer's "which are noise" question: nothing
    }),
    // Every other write to the database is recorded too.
    http.patch(`${SUPABASE}/:table`, ({ request }) => { record(request); return HttpResponse.json([]); }),
    http.put(`${SUPABASE}/:table`, ({ request }) => { record(request); return HttpResponse.json([]); }),
    http.delete(`${SUPABASE}/:table`, ({ request }) => { record(request); return HttpResponse.json([]); }),
    http.post(`${SUPABASE}/:table`, ({ request }) => { record(request); return HttpResponse.json([]); })
  );
  return seen;
}

function mockRes() {
  return {
    headers: {},
    statusCode: null,
    body: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
    end() { return this; },
  };
}
const authorized = { authorization: 'Bearer test-cron-secret' };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('preview: returns the digest instead of posting it', () => {
  it('hands back the main post, the reply for must-show mail, the buttons, and what was left out', async () => {
    const seen = setup();
    const result = await runDigest({ preview: true });

    expect(result.preview).toBe(true);
    expect(result.main).toMatch(/^\*🌅 Morning Digest — \w+day, \w+ \d{1,2}\*/);
    expect(result.main).toContain('*🔴 Action Required*\n- [#1] Alice Anders — Roof quote: approve the bid');
    expect(result.main).not.toMatch(/Carol|Rhoda|Parking/); // FYI and must-show mail are not in the main post
    expect(result.thread).toContain('Rhoda Altom — Family dinner'); // must-show: in the reply
    expect(result.buttons).toEqual(['#1 · Alice Anders — Roof quote']);
    expect(result.counts).toMatchObject({ work_orders_dropped: 1, replied_dropped: 1, spam_filtered: 1, hidden_fyi: 1, hidden_watching: 0 });
    expect(result.fetched).toBe(6);
    expect(seen.claude).toEqual(['spam', 'triage']); // just the two questions that shape the digest
  });

  it('shows exactly what a real run would post', async () => {
    setup();
    const preview = await runDigest({ preview: true });

    const real = setup();
    await runDigest();
    const main = real.posts.find((p) => !p.thread_ts);
    const thread = real.posts.find((p) => p.thread_ts);
    expect(preview.main).toBe(main.text);
    expect(preview.thread).toBe(thread.text);
    expect(preview.buttons).toHaveLength(main.blocks.filter((b) => b.type === 'actions').length);
  });

  it('works when there is nothing to show', async () => {
    setup({ emails: [] });
    const result = await runDigest({ preview: true });
    expect(result.main).toContain('No new emails');
    expect(result.thread).toBe('');
    expect(result.buttons).toEqual([]);
  });

  it('works when the model returns no text, and says so instead of failing', async () => {
    setup({ triage: '' });
    const result = await runDigest({ preview: true });
    expect(result.main).toContain('Claude returned no digest text');
    expect(result.counts.triage_failed).toBe(true);
  });
});

describe('preview: changes nothing', () => {
  it('posts nothing to Slack, writes nothing to the database, moves/files/archives/drafts/deletes no mail', async () => {
    vi.stubEnv('AUTO_ARCHIVE_SPAM', 'true'); // the riskiest setting: a real run would archive the spam
    const seen = setup();
    await runDigest({ preview: true });

    expect(seen.posts).toEqual([]);
    expect(seen.writes).toEqual([]);
  });

  it('leaves the next digest\'s lookback alone: no run row, no coverage time saved', async () => {
    const seen = setup();
    await runDigest({ preview: true });
    expect(seen.writes.filter((w) => w.includes('digest_runs') || w.includes('digest_items'))).toEqual([]);
  });

  it('skips the memory upkeep (summaries, entities), which only writes and is the slow part', async () => {
    const seen = setup();
    await runDigest({ preview: true });
    expect(seen.claude).not.toContain('summaries');
    expect(seen.claude).not.toContain('entities');
    expect(seen.writes.filter((w) => /email_messages|email_threads|entities|entity_mentions/.test(w))).toEqual([]);
  });

  it('does not delete old bot drafts or close/expire to-do items, which a real run does each morning', async () => {
    const seen = setup();
    const dayAgo = (d) => new Date(Date.now() - d * 24 * HOUR).toISOString();
    server.use(
      http.get(`${SUPABASE}/digest_items`, ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.has('auto_draft_created_at')) {
          // a bot draft 5 days old that Grant never touched: a real run deletes it
          return HttpResponse.json([{ id: 'old-1', auto_draft_id: 'draft-old-1', auto_draft_modified_at: 'T1', auto_draft_created_at: dayAgo(5) }]);
        }
        // an open to-do 9 days old: a real run expires it
        return HttpResponse.json([{
          id: 'todo-9', digest_run_id: 'older', item_number: 1, graph_message_id: 'm9', graph_conversation_id: 'conv-9',
          sender_name: 'Old Sender', sender_email: 'old@x.example', subject: 'Old thing', received_at: dayAgo(9), created_at: dayAgo(9),
          action_status: 'open', snoozed_until: null,
        }]);
      }),
      http.get(`${GRAPH}/messages/draft-old-1`, () => HttpResponse.json({ isDraft: true, lastModifiedDateTime: 'T1' }))
    );
    await runDigest({ preview: true });
    expect(seen.writes).toEqual([]); // no DELETE of the draft, no PATCH closing either item
  });

  it('never touches the delta cursor, even when one is set up (a real run would advance it)', async () => {
    const seen = setup({ deltaBootstrapped: true });
    // No handler for the cursor URL: if the preview followed it, the test would fail on an unmocked request.
    const result = await runDigest({ preview: true });
    expect(result.main).toContain('Roof quote');
    expect(seen.reads).not.toContain('inbox_delta_state');
    expect(seen.writes).toEqual([]);
  });

  it('looks back at least a day even right after a normal run, so there is something to show', async () => {
    const seen = setup({ lastCoverageEnd: new Date(Date.now() - 5 * 60_000).toISOString() });
    const result = await runDigest({ preview: true });
    const since = /receivedDateTime ge (\S+)/.exec(decodeURIComponent(seen.inboxUrls[0].searchParams.get('$filter')))[1];
    expect((Date.now() - Date.parse(since)) / HOUR).toBeCloseTo(24, 1);
    expect(result.lookback.hours).toBeCloseTo(24, 1);
  });
});

describe('preview: the web address', () => {
  it('refuses a caller without the secret', async () => {
    const seen = setup();
    const res = mockRes();
    await digestHandler({ method: 'GET', headers: {}, query: { preview: '1' } }, res);
    expect(res.statusCode).toBe(401);
    expect(seen.claude).toEqual([]); // and did no work
  });

  it('answers with the preview as plain text, never cached, and posts nothing', async () => {
    const seen = setup();
    const res = mockRes();
    await digestHandler({ method: 'POST', headers: authorized, query: { preview: '1' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatch(/^PREVIEW ONLY — nothing was posted, saved, filed, archived or changed\./);
    expect(res.body).toContain('MAIN POST');
    expect(res.body).toContain('Alice Anders — Roof quote');
    expect(res.body).toContain('REPLY UNDER IT');
    expect(res.body).toContain('Rhoda Altom — Family dinner');
    expect(res.body).toContain('Work-order mail dropped: 1');
    expect(seen.posts).toEqual([]);
    expect(seen.writes).toEqual([]);
  });

  it('is still only a preview if force=1 is added too', async () => {
    const seen = setup();
    const res = mockRes();
    await digestHandler({ method: 'GET', headers: authorized, query: { preview: '1', force: '1' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/^PREVIEW ONLY/);
    expect(seen.posts).toEqual([]);
    expect(seen.writes).toEqual([]);
  });

  it('reports a failure in plain text and posts nothing', async () => {
    const seen = setup();
    server.use(http.get(`${GRAPH}/mailFolders/Inbox/messages`, () => HttpResponse.json({ error: { message: 'boom' } }, { status: 400 })));
    const res = mockRes();
    await digestHandler({ method: 'GET', headers: authorized, query: { preview: '1' } }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatch(/^Preview failed \(nothing was posted or changed\)/);
    expect(seen.posts).toEqual([]);
  });
});

describe('formatPreview', () => {
  const base = { lookback: { hours: 24 }, fetched: 87, main: '*🌅 Morning Digest — Friday, November 6*', thread: '', buttons: [], counts: {} };

  it('says plainly when there is no reply and no buttons', () => {
    const text = formatPreview(base);
    expect(text).toContain('Looked back 24.0 hours');
    expect(text).toContain('read 87 emails');
    expect(text).toContain('Buttons that would appear: none');
    expect(text).toContain('(none: no must-show mail in this window)');
    expect(text).toContain('Work-order mail dropped: 0');
  });

  it('lists the buttons and the reply, and flags a window that hit the email limit', () => {
    const text = formatPreview({
      ...base,
      fetched: 100,
      truncated: true,
      fetchCap: 100,
      thread: '*🔒 Always shown*\n- Rhoda — hi',
      buttons: ['#3 · Lory Lybeck — Re: Suncrest'],
      counts: { work_orders_dropped: 2, replied_dropped: 3, spam_filtered: 4, hidden_watching: 5, hidden_fyi: 6 },
    });
    expect(text).toContain('stopped at the 100-email limit');
    expect(text).toContain('  #3 · Lory Lybeck — Re: Suncrest');
    expect(text).toContain('- Rhoda — hi');
    expect(text).toContain('Threads you already replied to, dropped: 3');
    expect(text).toContain('Watching / FYI mail not shown (not must-show): 11');
  });
});
