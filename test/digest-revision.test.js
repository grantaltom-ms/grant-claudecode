import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import { graphSentItemsHandler } from './mocks/handlers';
import { runDigest } from '../pages/api/digest';

// End-to-end checks for the Nov 4, 2026 digest revision, one behavior at a time.
// Everything outside the code under test is mocked (Graph, Slack, Supabase,
// Claude); the Claude triage reply is scripted per test so the checks are about
// what the code does with it.

const GRANT = 'grant@milestoneproperties.net';
const BASE = 'https://test-project.supabase.co/rest/v1';
const GRAPH = 'https://graph.microsoft.com/v1.0/users/:email';
const HOUR = 3_600_000;
const ARRIVED_AT = new Date(Date.now() - 2 * HOUR).toISOString();

const person = (address, name = '') => ({ emailAddress: { address, name } });

function mail({
  id, name, address, subject, preview = `Preview for ${subject}`, to = [person(GRANT, 'Grant Carlson')], cc = [],
  conv = `conv-${id}`, received = ARRIVED_AT, isRead = false, headers,
}) {
  return {
    id,
    conversationId: conv,
    internetMessageId: `<${id}@example.com>`,
    subject,
    from: person(address, name),
    toRecipients: to,
    ccRecipients: cc,
    receivedDateTime: received,
    sentDateTime: received,
    isRead,
    hasAttachments: false,
    importance: 'normal',
    bodyPreview: preview,
    body: { contentType: 'text', content: preview },
    internetMessageHeaders: [{ name: 'Authentication-Results', value: headers || 'spf=pass; dkim=pass; dmarc=pass' }],
  };
}

const reply = (text) => HttpResponse.json({
  id: 'm', type: 'message', role: 'assistant',
  content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text }],
  stop_reason: 'end_turn',
});

// A triage reply with no items in it (the model had nothing to list). Not an
// empty string: that is the model-returned-nothing failure path, tested on its own.
const NOTHING_ELSE = 'Nothing else to report.';
const EMPTY_REPLY = '';

// Wires up the whole digest run and records what the code sent where.
function setup({
  emails = [],
  triage = NOTHING_ELSE,
  spamIndices = [],
  sentByConversation = {},
  lastCoverageEnd = null,
  carryOver = [],
  slackOk = true,
  inboxFor,
} = {}) {
  const seen = {
    posts: [], triage: null, inboxUrls: [], coverageUrls: [], runPatches: [], itemInserts: [], itemPatches: [], moves: [],
  };
  server.use(
    graphSentItemsHandler(sentByConversation),
    http.get(`${GRAPH}/mailFolders/Inbox/messages`, ({ request }) => {
      seen.inboxUrls.push(new URL(request.url));
      return HttpResponse.json({ value: inboxFor ? inboxFor(new URL(request.url)) : emails });
    }),
    http.get(`${BASE}/digest_runs`, ({ request }) => {
      seen.coverageUrls.push(decodeURIComponent(request.url));
      return HttpResponse.json(lastCoverageEnd ? [{ metadata: { coverage_end: lastCoverageEnd } }] : []);
    }),
    http.post(`${BASE}/digest_runs`, () => HttpResponse.json({ id: 'run-1' })),
    http.patch(`${BASE}/digest_runs`, async ({ request }) => {
      seen.runPatches.push(await request.json());
      return HttpResponse.json([]);
    }),
    http.get(`${BASE}/digest_items`, ({ request }) =>
      HttpResponse.json(new URL(request.url).searchParams.has('auto_draft_created_at') ? [] : carryOver)
    ),
    http.post(`${BASE}/digest_items`, async ({ request }) => {
      const rows = await request.json();
      seen.itemInserts.push(...rows);
      return HttpResponse.json(rows.map((row) => ({ id: `item-${row.item_number}`, ...row })));
    }),
    http.patch(`${BASE}/digest_items`, async ({ request }) => {
      seen.itemPatches.push({ body: await request.json(), url: decodeURIComponent(request.url) });
      return HttpResponse.json([]);
    }),
    http.post(`${GRAPH}/messages/:id/move`, ({ params }) => {
      seen.moves.push(params.id);
      return HttpResponse.json({ id: `moved-${params.id}` });
    }),
    http.post('https://api.anthropic.com/v1/messages', async ({ request }) => {
      const body = await request.json();
      const system = typeof body.system === 'string' ? body.system : (body.system?.[0]?.text || '');
      if (system.includes('spam filter')) return reply(JSON.stringify(spamIndices));
      if (system.includes('Extract durable business entities')) return reply('[]');
      if (system.includes('summarize business email threads')) {
        return reply(JSON.stringify({ current_summary: 's', open_items: [], status: 'active' }));
      }
      if (system.includes('morning email triage assistant')) {
        seen.triage = { system, user: body.messages[0].content };
        return reply(typeof triage === 'function' ? triage(seen.triage.user) : triage);
      }
      return reply('[]'); // the auto-filer's "which are noise" question: nothing
    }),
    http.post('https://slack.com/api/chat.postMessage', async ({ request }) => {
      const body = await request.json();
      seen.posts.push(body);
      return slackOk
        ? HttpResponse.json({ ok: true, ts: `${1700000000 + seen.posts.length}.000001` })
        : HttpResponse.json({ ok: false, error: 'channel_not_found' });
    })
  );
  return seen;
}

const lastRunPatch = (seen) => seen.runPatches[seen.runPatches.length - 1];
const digestText = (seen) => seen.posts[0].text;
const windowHoursOf = (url) => {
  const since = /receivedDateTime ge (\S+)/.exec(decodeURIComponent(url.searchParams.get('$filter')))[1];
  return (Date.now() - Date.parse(since)) / HOUR;
};

afterEach(() => {
  vi.unstubAllEnvs();
});

const simple = [mail({ id: 'a1', name: 'Alice Anders', address: 'alice@a.example', subject: 'Roof quote' })];
const ACTION_A1 = '*🔴 Action Required*\n- [#1] Alice Anders — Roof quote: needs a decision';

describe('lookback: since the last successful digest', () => {
  it('looks back 24 hours when no coverage time has been stored yet', async () => {
    const seen = setup({ emails: simple, triage: ACTION_A1 });
    await runDigest();
    const url = seen.inboxUrls[0];
    expect(windowHoursOf(url)).toBeCloseTo(24, 1);
    expect(url.searchParams.get('$top')).toBe('51'); // cap 50, +1 to notice overflow
  });

  it('looks back ~72 hours on a Monday, with a fetch cap that grows to match', async () => {
    const seen = setup({ emails: simple, triage: ACTION_A1, lastCoverageEnd: new Date(Date.now() - 72 * HOUR).toISOString() });
    await runDigest();
    expect(windowHoursOf(seen.inboxUrls[0])).toBeCloseTo(72, 1);
    expect(seen.inboxUrls[0].searchParams.get('$top')).toBe('121'); // cap 120
    expect(seen.runPatches.length).toBeGreaterThan(0);
  });

  it('never looks back more than 96 hours, and the cap tops out at 150', async () => {
    const seen = setup({ emails: simple, triage: ACTION_A1, lastCoverageEnd: new Date(Date.now() - 300 * HOUR).toISOString() });
    await runDigest();
    expect(windowHoursOf(seen.inboxUrls[0])).toBeCloseTo(96, 1);
    expect(seen.inboxUrls[0].searchParams.get('$top')).toBe('151');
  });

  it('a forced re-run right after a normal run still covers a full day', async () => {
    const seen = setup({ emails: simple, triage: ACTION_A1, lastCoverageEnd: new Date(Date.now() - 5 * 60_000).toISOString() });
    await runDigest({ force: true });
    expect(windowHoursOf(seen.inboxUrls[0])).toBeCloseTo(24, 1);
  });

  it('asks only for runs that really completed and have a coverage time', async () => {
    const seen = setup({ emails: simple, triage: ACTION_A1 });
    await runDigest();
    const url = seen.coverageUrls[0];
    expect(url).toContain('owner_email=eq.grant@milestoneproperties.net');
    expect(url).toMatch(/status=in\.\(.*posted.*no_emails.*no_actionable.*\)/);
    expect(url).toContain('metadata->>coverage_end=not.is.null');
    expect(url).toContain('order=run_started_at.desc');
  });

  it('tells the model how far back this stretch reaches', async () => {
    const seen = setup({ emails: simple, triage: ACTION_A1, lastCoverageEnd: new Date(Date.now() - 72 * HOUR).toISOString() });
    await runDigest();
    expect(seen.triage.user).toMatch(/last 72 hours/);
  });
});

describe('coverage time is saved on each successful run', () => {
  it('stores the moment the fetch started, not when the run finished', async () => {
    const before = Date.now();
    const seen = setup({ emails: simple, triage: ACTION_A1 });
    await runDigest();
    const patch = lastRunPatch(seen);
    expect(patch.status).toBe('posted');
    const end = Date.parse(patch.metadata.coverage_end);
    expect(end).toBeGreaterThanOrEqual(before);
    expect(end).toBeLessThanOrEqual(Date.now());
    expect(patch.metadata).toMatchObject({ window_source: 'default_24h', fetch_cap: 50, fetch_truncated: false });
  });

  it('is saved for a quiet day too (no new emails)', async () => {
    const seen = setup({ emails: [] });
    await runDigest();
    expect(lastRunPatch(seen)).toMatchObject({ status: 'no_emails' });
    expect(lastRunPatch(seen).metadata.coverage_end).toBeTruthy();
    expect(digestText(seen)).toContain('No new emails in the last 24 hours');
  });

  it('says "since the last digest" once a coverage time exists', async () => {
    const seen = setup({ emails: [], lastCoverageEnd: new Date(Date.now() - 24 * HOUR).toISOString() });
    await runDigest();
    expect(digestText(seen)).toContain('No new emails since the last digest');
  });

  it('is NOT saved when the digest never reached Slack, so the next run covers the same mail', async () => {
    const seen = setup({ emails: simple, triage: ACTION_A1, slackOk: false });
    await runDigest();
    expect(lastRunPatch(seen).metadata.coverage_end).toBeUndefined();
  });

  it('is NOT saved when the model returned no digest text', async () => {
    const seen = setup({ emails: simple, triage: EMPTY_REPLY });
    await runDigest();
    expect(digestText(seen)).toContain('Claude returned no digest text');
    expect(lastRunPatch(seen).metadata.coverage_end).toBeUndefined();
  });
});

describe('a window with more mail than the fetch cap is reported, not silently cut', () => {
  const lots = (n) => Array.from({ length: n }, (_, i) => mail({ id: `bulk-${i}`, name: `Sender ${i}`, address: `s${i}@x.example`, subject: `Topic ${i}` }));

  it('warns when a normal day exceeds the cap of 50', async () => {
    const seen = setup({ emails: lots(51), triage: '*🟡 FYI / Needs Awareness*\n- [#1] Sender 0 — Topic 0: x' });
    await runDigest();
    expect(digestText(seen)).toMatch(/Too much mail for one pass: only the newest 50 emails/);
    expect(lastRunPatch(seen).metadata).toMatchObject({ fetch_truncated: true });
  });

  it('a Monday-sized window holds 100 emails without a warning (the old cap of 50 would have cut it)', async () => {
    const seen = setup({
      emails: lots(100),
      triage: '*🟡 FYI / Needs Awareness*\n- [#1] Sender 0 — Topic 0: x',
      lastCoverageEnd: new Date(Date.now() - 72 * HOUR).toISOString(),
    });
    await runDigest();
    expect(digestText(seen)).not.toMatch(/Too much mail/);
    expect(seen.itemInserts).toHaveLength(100);
  });
});

describe('the triage model can see who each email was addressed to', () => {
  it('lists To: and Cc: lines for every email, and flags a cc-only email', async () => {
    const emails = [
      mail({ id: 'd1', name: 'Dana Diaz', address: 'dana@d.example', subject: 'Gate repair',
        to: [person('kelsey@milestoneproperties.net', 'Kelsey Dempsey')], cc: [person(GRANT, 'Grant Carlson'), person('jeri@x.example')] }),
      mail({ id: 'd2', name: 'Evan Ellis', address: 'evan@e.example', subject: 'Paint colors' }),
    ];
    const seen = setup({ emails, triage: NOTHING_ELSE });
    await runDigest();
    const user = seen.triage.user;
    expect(user).toContain('   To: Kelsey Dempsey <kelsey@milestoneproperties.net>');
    expect(user).toContain('   Cc: Grant Carlson <grant@milestoneproperties.net>, jeri@x.example');
    expect(user).toContain('   To: Grant Carlson <grant@milestoneproperties.net>\n   Cc: (none)');
    const [first, second] = user.split(/\n(?=\d+\. From:)/).filter((b) => /^\d+\. From:/.test(b));
    expect(first).toContain("Grant is only cc'd");
    expect(second).not.toContain("Grant is only cc'd");
    // The Graph query itself asked for the recipient fields.
    const select = seen.inboxUrls[0].searchParams.get('$select');
    expect(select).toContain('toRecipients');
    expect(select).toContain('ccRecipients');
  });

  it('writes the addressee rule, the watching bucket, and no System Alerts bucket, into the prompt', async () => {
    const seen = setup({ emails: simple, triage: NOTHING_ELSE });
    await runDigest();
    const { system } = seen.triage;
    expect(system).toContain('*👀 Watching*');
    expect(system).toMatch(/only cc'd/);
    expect(system).toMatch(/\(owner: \[Name\]\)/);
    expect(system).toMatch(/money, legal matters, or a deadline within 48 hours/);
    expect(system).toMatch(/HARD FLOORS/);
    expect(system).not.toContain('*🔧 System Alerts*');
    expect(system).not.toMatch(/emails total|need action/);
  });

  it('gives the model today\'s date, which the 48-hour rule needs', async () => {
    const seen = setup({ emails: simple, triage: NOTHING_ELSE });
    await runDigest();
    expect(seen.triage.system).toMatch(/Today is \w+day, \w+ \d{1,2}, 20\d\d \(Pacific time\)/);
  });
});

describe('work-order mail never appears', () => {
  const emails = [
    mail({ id: 'w1', name: 'AppFolio', address: 'noreply@appfolio.com', subject: 'Work Order #1042-1 completed - Unit 4B' }),
    mail({ id: 'w2', name: 'Rhoda Altom', address: 'rhoda@milestoneproperties.net', subject: 'Re: work order for the boiler', preview: 'Please approve the $4,200 estimate.' }),
    mail({ id: 'w3', name: 'Kelsey Dempsey', address: 'kelsey@milestoneproperties.net', subject: 'Unit 9 faucet', preview: 'A new work order has been created for Unit 9.' }),
    mail({ id: 'n1', name: 'Nina Novak', address: 'nina@n.example', subject: 'Lease renewal question' }),
  ];

  it('is dropped before triage, saved nowhere, and shown in no bucket - even from a must-show sender', async () => {
    const seen = setup({ emails, triage: '*🔴 Action Required*\n- [#1] Nina Novak — Lease renewal question: reply' });
    await runDigest();
    expect(seen.triage.user).not.toMatch(/Work Order|work order|boiler|Unit 9/);
    expect(seen.triage.user).toContain('Lease renewal question');
    expect(seen.itemInserts.map((r) => r.subject)).toEqual(['Lease renewal question']);
    expect(digestText(seen)).not.toMatch(/Work Order|work order|boiler|faucet/);
    expect(lastRunPatch(seen).metadata.work_orders_dropped).toBe(3);
  });

  it('is not floored either: a must-show sender\'s work order stays out, but their other mail shows', async () => {
    const seen = setup({
      emails: [emails[1], mail({ id: 'r2', name: 'Rhoda Altom', address: 'rhoda@milestoneproperties.net', subject: 'Dinner Friday?' })],
      triage: NOTHING_ELSE,
    });
    await runDigest();
    expect(digestText(seen)).toContain('Dinner Friday?');
    expect(digestText(seen)).not.toMatch(/boiler/);
  });
});

describe('threads Grant already replied to are dropped, even the same day', () => {
  const emails = [
    mail({ id: 'r1', name: 'Pat Perez', address: 'pat@p.example', subject: 'Parking permit question', conv: 'conv-pat' }),
    mail({ id: 'r2', name: 'Quinn Quade', address: 'quinn@q.example', subject: 'Move-in date', conv: 'conv-quinn', isRead: true }),
  ];

  it('drops a thread replied to later the same day: not shown, not saved as an item, not on the to-do list', async () => {
    const repliedAt = new Date(Date.parse(ARRIVED_AT) + 30 * 60_000).toISOString();
    const seen = setup({
      emails,
      sentByConversation: { 'conv-pat': [repliedAt] },
      triage: '*🔴 Action Required*\n- [#1] Quinn Quade — Move-in date: confirm',
    });
    await runDigest();

    expect(seen.triage.user).not.toContain('Parking permit question');
    expect(digestText(seen)).not.toContain('Pat Perez');
    expect(seen.itemInserts.map((r) => r.subject)).toEqual(['Move-in date']);
    // The one that stays is numbered #1 everywhere: the prompt, the saved item, the digest.
    expect(seen.triage.user).toMatch(/^1\. From: Quinn Quade/m);
    expect(seen.itemPatches.filter((p) => p.body.classification === 'action_required')).toHaveLength(1);
    expect(lastRunPatch(seen).metadata.replied_dropped).toBe(1);
  });

  it('judges read-but-unreplied mail normally', async () => {
    const seen = setup({ emails, triage: '*🔴 Action Required*\n- [#2] Quinn Quade — Move-in date: confirm' });
    await runDigest();
    expect(seen.triage.user).toMatch(/Move-in date \| Read: true/);
    expect(digestText(seen)).toContain('Quinn Quade');
  });

  it('a reply sent BEFORE the email arrived does not count', async () => {
    const earlier = new Date(Date.parse(ARRIVED_AT) - 60 * 60_000).toISOString();
    const seen = setup({ emails, sentByConversation: { 'conv-pat': [earlier] }, triage: NOTHING_ELSE });
    await runDigest();
    expect(seen.triage.user).toContain('Parking permit question');
  });

  it('keeps the email when the Sent Items check itself fails', async () => {
    const seen = setup({ emails: [emails[0]], triage: NOTHING_ELSE });
    server.use(http.get(`${GRAPH}/mailFolders/sentitems/messages`, () => HttpResponse.json({ error: { message: 'boom' } }, { status: 400 })));
    await runDigest();
    expect(seen.triage.user).toContain('Parking permit question');
    expect(lastRunPatch(seen).metadata.reply_check_failed).toBe(1);
  });
});

describe('the 👀 Watching bucket', () => {
  const emails = [
    mail({ id: 'b1', name: 'Alice Anders', address: 'alice@a.example', subject: 'Roof quote' }),
    mail({ id: 'b2', name: 'Bob Baker', address: 'bob@b.example', subject: 'Gutter cleaning', to: [person('kelsey@milestoneproperties.net', 'Kelsey Dempsey')], cc: [person(GRANT)] }),
    mail({ id: 'b3', name: 'Carol Chen', address: 'carol@c.example', subject: 'Parking signs' }),
  ];
  const triage =
    '*🌅 Morning Digest — whatever*\n\n' +
    '*🔴 Action Required*\n- [#1] Alice Anders — Roof quote: approve the bid\n\n' +
    '*👀 Watching*\n- [#2] Bob Baker — Gutter cleaning: Kelsey is scheduling (owner: Kelsey Dempsey)\n\n' +
    '*🟡 FYI / Needs Awareness*\n- [#3] Carol Chen — Parking signs: new signs ordered\n\n' +
    '3 emails total — 1 needs action';

  it('sits between Action Required and FYI, names the owner, and carries no numbers', async () => {
    const seen = setup({ emails, triage });
    await runDigest();
    const text = digestText(seen);
    expect(text.indexOf('🔴 Action Required')).toBeLessThan(text.indexOf('👀 Watching'));
    expect(text.indexOf('👀 Watching')).toBeLessThan(text.indexOf('🟡 FYI'));
    expect(text).toContain('Gutter cleaning: Kelsey is scheduling (owner: Kelsey Dempsey)');
    expect(text).toContain('[#1] Alice Anders'); // Action Required keeps its number
    expect(text).not.toMatch(/\[#[23]\]/);
  });

  it('gets no buttons, is not saved to the to-do list, and does not carry over', async () => {
    const seen = setup({ emails, triage });
    await runDigest();
    const rows = seen.posts[0].blocks.filter((b) => b.type === 'actions').map((b) => b.block_id);
    expect(rows).toEqual(['todo_item-1']);
    const marked = seen.itemPatches.filter((p) => p.body.classification === 'action_required');
    expect(marked).toHaveLength(1);
    expect(marked[0].url).toContain('id=eq.item-1');
    expect(seen.itemPatches.some((p) => p.body.classification && p.body.classification !== 'action_required')).toBe(false);
    expect(lastRunPatch(seen).metadata).toMatchObject({ todo_today: 1, watching_shown: 1, fyi_shown: 1 });
  });
});

describe('caps: 5 each for Watching and FYI, Action Required uncapped', () => {
  const emails = Array.from({ length: 22 }, (_, i) => mail({ id: `c${i + 1}`, name: `Person${String.fromCharCode(65 + i)} Last`, address: `p${i + 1}@x.example`, subject: `Subject ${i + 1}` }));
  const line = (n, tail = '') => `- [#${n}] Person${String.fromCharCode(64 + n)} Last — Subject ${n}: summary${tail}`;
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

  it('shows the top 5 of each, one "…and N more, not listed" line inside the bucket, and every Action Required item', async () => {
    const triage =
      `*🔴 Action Required*\n${range(1, 7).map((n) => line(n)).join('\n')}\n\n` +
      `*👀 Watching*\n${range(8, 14).map((n) => line(n, ' (owner: Kelsey)')).join('\n')}\n\n` +
      `*🟡 FYI / Needs Awareness*\n${range(15, 22).map((n) => line(n)).join('\n')}`;
    const seen = setup({ emails, triage });
    await runDigest();
    const text = digestText(seen);
    const watching = text.slice(text.indexOf('*👀 Watching*'), text.indexOf('*🟡 FYI'));
    const fyi = text.slice(text.indexOf('*🟡 FYI'));
    expect(text.match(/\[#\d+\]/g)).toHaveLength(7);
    expect(watching.match(/^- /gm)).toHaveLength(5);
    expect(watching).toContain('…and 2 more, not listed');
    expect(fyi.match(/^- /gm)).toHaveLength(5);
    expect(fyi).toContain('…and 3 more, not listed');
    expect(text.match(/not listed/g)).toHaveLength(2);
  });
});

describe('hard floors', () => {
  const emails = [
    mail({ id: 'f1', name: 'Rhoda Altom', address: 'rhoda@milestoneproperties.net', subject: 'Family dinner' }),
    mail({ id: 'f2', name: 'Caitlin Sogn', address: 'caitlin@collegeclub.org', subject: 'Club newsletter' }),
    mail({ id: 'f3', name: 'GreenScape', address: 'billing@greenscapewa.com', subject: 'Invoice #4471 past due' }),
    mail({ id: 'f4', name: 'Helmut Hummes', address: 'helmut@hummes.example', subject: 'Hello from Helmut' }),
    mail({ id: 'f5', name: 'Caitlin Brisson', address: 'caitlin@brisson.example', subject: 'Weekend plans' }),
  ];

  it('always shows mail from the named people (by address) and money mail, even when the model discards it', async () => {
    vi.stubEnv('DIGEST_PRIORITY_SENDERS', JSON.stringify([
      { name: 'Helmut Hummes', emails: ['helmut@hummes.example'] },
      { name: 'Caitlin Brisson', emails: ['caitlin@brisson.example'] },
    ]));
    const seen = setup({ emails, triage: '*🔴 Action Required*\n- [#2] Caitlin Sogn — Club newsletter: reply' });
    await runDigest();
    const text = digestText(seen);
    expect(text).toContain('Family dinner'); // Rhoda, by her address
    expect(text).toContain('Hello from Helmut');
    expect(text).toContain('Weekend plans'); // Caitlin BRISSON
    expect(text).toContain('Invoice #4471 past due'); // money
    expect(seen.triage.user).toMatch(/Family dinner[^\n]*MUST APPEAR \(priority sender: Rhoda Altom\)/);
    expect(seen.triage.user).toMatch(/Invoice #4471 past due[^\n]*MUST APPEAR \(money mail\)/);
  });

  it('does not treat Caitlin Sogn as Caitlin Brisson', async () => {
    vi.stubEnv('DIGEST_PRIORITY_SENDERS', JSON.stringify([{ name: 'Caitlin Brisson', emails: ['caitlin@brisson.example'] }]));
    const seen = setup({ emails: [emails[1]], triage: NOTHING_ELSE });
    await runDigest();
    expect(seen.triage.user).toContain('Club newsletter'); // she was triaged like anyone else...
    expect(seen.triage.user).not.toContain('MUST APPEAR'); // ...with no floor
    expect(digestText(seen)).toContain('Nothing new needs your attention');
    expect(digestText(seen)).not.toContain('Caitlin Sogn');
  });

  it('keeps a must-show sender out of the spam filter', async () => {
    const seen = setup({ emails: [emails[0], emails[1]], spamIndices: [0, 1], triage: NOTHING_ELSE });
    vi.stubEnv('AUTO_ARCHIVE_SPAM', 'true');
    await runDigest();
    expect(digestText(seen)).toContain('Family dinner');
    expect(seen.moves).toEqual(['f2']); // only Caitlin Sogn's mail was archived
  });

  it('does not override the already-replied drop', async () => {
    const repliedAt = new Date(Date.parse(ARRIVED_AT) + 60_000).toISOString();
    const seen = setup({ emails: [emails[0]], sentByConversation: { 'conv-f1': [repliedAt] }, triage: NOTHING_ELSE });
    await runDigest();
    expect(digestText(seen)).toContain('Nothing new needs your attention');
    expect(digestText(seen)).not.toContain('Family dinner');
    expect(seen.triage).toBeNull(); // nothing left to triage
  });
});

describe('the post ends after the last bucket', () => {
  const emails = [
    mail({ id: 'e1', name: 'Alice Anders', address: 'alice@a.example', subject: 'Roof quote' }),
    mail({ id: 'e2', name: 'Spammy', address: 'spam@s.example', subject: 'Buy now' }),
  ];

  it('has no closing count, no routine count footnotes, and no follow-up message about the buttons', async () => {
    vi.stubEnv('AUTO_ARCHIVE_SPAM', 'true');
    const seen = setup({
      emails, spamIndices: [1],
      triage: `${ACTION_A1}\n\n2 emails total — 1 need action\n_🗑️ 1 spam email auto-archived_\n_📝 1 reply draft waiting_`,
    });
    await runDigest();
    expect(seen.posts).toHaveLength(1);
    const text = digestText(seen);
    expect(text.trim().endsWith('needs a decision')).toBe(true);
    expect(text).not.toMatch(/emails total|need action|spam|archived|filtered|drafts?\b|Filed|To-do list|Each item above/i);
  });

  it('still shows genuine warnings: a failed archive', async () => {
    vi.stubEnv('AUTO_ARCHIVE_SPAM', 'true');
    const seen = setup({ emails, spamIndices: [1], triage: ACTION_A1 });
    server.use(http.post(`${GRAPH}/messages/:id/move`, () => HttpResponse.json({ error: { message: 'nope' } }, { status: 400 })));
    await runDigest();
    expect(digestText(seen)).toContain('1 spam email failed to archive — still in Inbox');
  });

  it('says plainly when nothing new needs attention, and still lists items still open from earlier', async () => {
    const dayAgo = (d) => new Date(Date.now() - d * 24 * HOUR).toISOString();
    const open = (id, conv, days) => ({
      id, digest_run_id: 'older-run', item_number: 1, graph_message_id: `msg-${id}`, graph_conversation_id: conv,
      sender_name: `Sender ${id}`, sender_email: `${id}@x.example`, subject: `Subject ${id}`,
      received_at: dayAgo(days), created_at: dayAgo(days), action_status: 'open', snoozed_until: null,
    });
    const seen = setup({
      emails: [mail({ id: 'w9', name: 'AppFolio', address: 'noreply@appfolio.com', subject: 'Work Order #9 updated' })],
      carryOver: [open('five', 'conv-five', 5), open('nine', 'conv-nine', 9)],
    });
    await runDigest();
    const text = digestText(seen);
    expect(text).toContain('Nothing new needs your attention');
    expect(text).toContain('📌 Still open from earlier');
    expect(text).toContain('Sender five'); // 5 days old: kept (used to be dropped after 3)
    expect(text).not.toContain('Sender nine'); // 9 days old: past the 7-day limit
    expect(text).not.toMatch(/dropped after|closed because/);
  });
});

describe('the fraud check still sees what the drops keep out of the digest', () => {
  it('flags a spoofed payment-change request even when it is work-order mail', async () => {
    const spoof = mail({
      id: 's1', name: 'GreenScape', address: 'billing@greenscapewa.com', subject: 'Work order 55 - updated banking details',
      preview: 'Please use our new account number and routing number for the work order payment.',
      headers: 'spf=fail; dkim=fail; dmarc=fail',
    });
    const seen = setup({ emails: [spoof], triage: NOTHING_ELSE });
    await runDigest();
    const text = digestText(seen);
    expect(text).toContain('AUTHENTICATION FAILURE DETECTED');
    expect(text).toContain('GreenScape');
    expect(text).not.toMatch(/\[#\d+\]/); // it isn't a digest item, so it has no number
  });
});
