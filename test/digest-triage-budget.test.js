import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import { graphSentItemsHandler } from './mocks/handlers';
import { runDigest } from '../pages/api/digest';
import { THINKING_HEADROOM_TOKENS } from '../lib/claude';
import { TRIAGE_MAX_TOKENS, TRIAGE_RETRY_MAX_TOKENS } from '../lib/digest-triage';

// Regression tests for the Nov 9-10, 2026 failures: on a Monday (~72h of mail,
// growing to the 96h cap because a failed run does not advance coverage) the
// triage reply ran out of tokens, came back with no text (stop_reason
// max_tokens), and only the "Claude returned no digest text" warning posted.

const GRANT = 'grant@milestoneproperties.net';
const BASE = 'https://test-project.supabase.co/rest/v1';
const GRAPH = 'https://graph.microsoft.com/v1.0/users/:email';
const HOUR = 3_600_000;

function mail(i) {
  const received = new Date(Date.now() - (2 + (i % 80)) * HOUR).toISOString();
  return {
    id: `m-${i}`,
    conversationId: `conv-${i}`,
    internetMessageId: `<m-${i}@example.com>`,
    subject: `Topic ${i}`,
    from: { emailAddress: { address: `sender${i}@x.example`, name: `Sender ${i}` } },
    toRecipients: [{ emailAddress: { address: GRANT, name: 'Grant Carlson' } }],
    ccRecipients: [],
    receivedDateTime: received,
    sentDateTime: received,
    isRead: false,
    hasAttachments: false,
    importance: 'normal',
    bodyPreview: `Preview for topic ${i}`,
    body: { contentType: 'text', content: `Preview for topic ${i}` },
    internetMessageHeaders: [{ name: 'Authentication-Results', value: 'spf=pass; dkim=pass; dmarc=pass' }],
  };
}

const message = (content, stopReason = 'end_turn') => HttpResponse.json({
  id: 'm', type: 'message', role: 'assistant', content, stop_reason: stopReason,
});
const reply = (text) => message([{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text }]);
// What Claude sends back when the budget runs out mid-thinking: no text block at all.
const outOfTokens = () => message([{ type: 'thinking', thinking: 'still sorting…', signature: 's' }], 'max_tokens');

// The [#N] numbers and the "Sender i — Topic i" text of each email line the
// triage was shown, read back from the prompt itself.
function shownEmails(user) {
  return [...user.matchAll(/^(\d+)\. From: Sender (\d+) </gm)].map((m) => ({ n: Number(m[1]), i: Number(m[2]) }));
}

function setup({ emails, triage, lastCoverageEnd = null }) {
  const seen = { posts: [], triageCalls: [], runPatches: [], itemInserts: [] };
  server.use(
    graphSentItemsHandler({}),
    http.get(`${GRAPH}/mailFolders/Inbox/messages`, () => HttpResponse.json({ value: emails })),
    http.get(`${BASE}/digest_runs`, () =>
      HttpResponse.json(lastCoverageEnd ? [{ metadata: { coverage_end: lastCoverageEnd } }] : [])
    ),
    http.post(`${BASE}/digest_runs`, () => HttpResponse.json({ id: 'run-1' })),
    http.patch(`${BASE}/digest_runs`, async ({ request }) => {
      seen.runPatches.push(await request.json());
      return HttpResponse.json([]);
    }),
    http.get(`${BASE}/digest_items`, () => HttpResponse.json([])),
    http.post(`${BASE}/digest_items`, async ({ request }) => {
      const rows = await request.json();
      seen.itemInserts.push(...rows);
      return HttpResponse.json(rows.map((row) => ({ id: `item-${row.item_number}`, ...row })));
    }),
    http.patch(`${BASE}/digest_items`, () => HttpResponse.json([])),
    http.post(`${GRAPH}/messages/:id/move`, ({ params }) => HttpResponse.json({ id: `moved-${params.id}` })),
    http.post('https://api.anthropic.com/v1/messages', async ({ request }) => {
      const body = await request.json();
      const system = typeof body.system === 'string' ? body.system : (body.system?.[0]?.text || '');
      if (system.includes('spam filter')) return reply('[]');
      if (system.includes('Extract durable business entities')) return reply('[]');
      if (system.includes('summarize business email threads')) {
        return reply(JSON.stringify({ current_summary: 's', open_items: [], status: 'active' }));
      }
      if (system.includes('morning email triage assistant')) {
        const call = { user: body.messages[0].content, maxTokens: body.max_tokens, attempt: seen.triageCalls.length + 1 };
        seen.triageCalls.push(call);
        return triage(call);
      }
      return reply('[]'); // the auto-filer's "which are noise" question: nothing
    }),
    http.post('https://slack.com/api/chat.postMessage', async ({ request }) => {
      seen.posts.push(await request.json());
      return HttpResponse.json({ ok: true, ts: `${1700000000 + seen.posts.length}.000001` });
    })
  );
  return seen;
}

const lastRunPatch = (seen) => seen.runPatches[seen.runPatches.length - 1];
const digestPost = (seen) => seen.posts.find((p) => !p.thread_ts);
const buttonRows = (post) => (post.blocks || []).filter((b) => b.type === 'actions').map((b) => b.block_id);

describe('triage budget', () => {
  it('asks for a 12000-token answer (plus the thinking headroom), not 4000', async () => {
    const seen = setup({
      emails: [mail(0)],
      triage: () => reply('*🔴 Action Required*\n- [#1] Sender 0 — Topic 0: needs a decision'),
    });
    await runDigest();
    expect(seen.triageCalls).toHaveLength(1);
    expect(seen.triageCalls[0].maxTokens).toBe(TRIAGE_MAX_TOKENS + THINKING_HEADROOM_TOKENS);
    expect(TRIAGE_MAX_TOKENS).toBe(12000);
  });
});

describe('when the triage reply runs out of tokens', () => {
  it('retries once at double the budget and posts the real digest (coverage advances)', async () => {
    const seen = setup({
      emails: [mail(0), mail(1)],
      triage: ({ attempt }) => (attempt === 1
        ? outOfTokens()
        : reply('*🔴 Action Required*\n- [#2] Sender 1 — Topic 1: needs a signature')),
    });
    await runDigest();

    expect(seen.triageCalls.map((c) => c.maxTokens)).toEqual([
      TRIAGE_MAX_TOKENS + THINKING_HEADROOM_TOKENS,
      TRIAGE_RETRY_MAX_TOKENS + THINKING_HEADROOM_TOKENS,
    ]);
    expect(TRIAGE_RETRY_MAX_TOKENS).toBe(24000);
    const post = digestPost(seen);
    expect(post.text).not.toContain('Claude returned no digest text');
    expect(post.text).toContain('🔴 Action Required');
    expect(post.text).toContain('[#2] Sender 1 — Topic 1');
    expect(buttonRows(post)).toEqual(['todo_item-2']);
    expect(lastRunPatch(seen).metadata.coverage_end).toBeTruthy();
    expect(lastRunPatch(seen).metadata).toMatchObject({ triage_retries: 1, triage_batches: 1 });
  });

  it('retries only once: if the retry also has no text, the warning posts and coverage does NOT advance', async () => {
    const seen = setup({ emails: [mail(0)], triage: () => outOfTokens() });
    await runDigest();
    expect(seen.triageCalls).toHaveLength(2);
    expect(digestPost(seen).text).toContain('Claude returned no digest text today (stop reason: max_tokens)');
    expect(lastRunPatch(seen).metadata.coverage_end).toBeUndefined();
  });

  it('does not retry a reply that is empty for some other reason', async () => {
    const seen = setup({ emails: [mail(0)], triage: () => message([], 'end_turn') });
    await runDigest();
    expect(seen.triageCalls).toHaveLength(1);
    expect(digestPost(seen).text).toContain('Claude returned no digest text');
    expect(lastRunPatch(seen).metadata.coverage_end).toBeUndefined();
  });
});

describe('a large window (the capped 96h Monday-after-failures case)', () => {
  // 90 emails over the last ~82h, with the last good digest 5 days ago (so the
  // lookback is clamped to the 96h cap).
  const emails = Array.from({ length: 90 }, (_, i) => mail(i));
  const lastCoverageEnd = new Date(Date.now() - 120 * HOUR).toISOString();

  // Each batch flags its first and last email as Action Required and puts the
  // rest in FYI, always quoting the email's OWN number and sender from the
  // prompt -- plus one mis-numbered line pointing outside the batch, which must
  // not survive the merge.
  const perBatch = ({ user }) => {
    const shown = shownEmails(user);
    const first = shown[0];
    const last = shown[shown.length - 1];
    const line = ({ n, i }, note) => `- [#${n}] Sender ${i} — Topic ${i}: ${note}`;
    return reply([
      '*🌅 Morning Digest — Batch title the model invented*',
      '',
      '*🔴 Action Required*',
      line(first, 'needs a reply'),
      line(last, 'needs a signature'),
      '- [#999] Nobody — Not in this batch: stray',
      '',
      '*🟡 FYI / Needs Awareness*',
      ...shown.slice(1, -1).map((e) => line(e, 'fyi')),
    ].join('\n'));
  };

  it('splits into batches of at most 40, keeps every email on its own number, and posts one normal digest', async () => {
    const seen = setup({ emails, triage: perBatch, lastCoverageEnd });
    await runDigest();

    // 90 candidates -> 3 batches of 30, each shown its own slice with the
    // global numbers (1-30, 31-60, 61-90) and told it is one batch of three.
    expect(seen.triageCalls).toHaveLength(3);
    const ranges = seen.triageCalls.map(({ user }) => shownEmails(user).map((e) => e.n));
    const sorted = ranges.sort((a, b) => a[0] - b[0]);
    expect(sorted.map((r) => [r[0], r[r.length - 1], r.length])).toEqual([[1, 30, 30], [31, 60, 30], [61, 90, 30]]);
    for (const r of sorted) expect(r.length).toBeLessThanOrEqual(40);
    // In every batch, [#N] is the Nth candidate: Sender N-1.
    for (const { user } of seen.triageCalls) {
      for (const { n, i } of shownEmails(user)) expect(i).toBe(n - 1);
    }
    expect(seen.triageCalls[0].user).toMatch(/batch \d of 3/);

    const post = digestPost(seen);
    expect(post.text).not.toContain('Claude returned no digest text');
    expect(post.text).not.toContain('Batch title the model invented');
    expect(post.text).not.toContain('#999');
    // One Action Required bucket holding every batch's items, in number order.
    expect(post.text.match(/🔴 Action Required/g)).toHaveLength(1);
    const actionNumbers = [...post.text.matchAll(/\[#(\d+)\] Sender (\d+) — Topic (\d+)/g)]
      .map((m) => ({ n: Number(m[1]), sender: Number(m[2]), topic: Number(m[3]) }));
    expect(actionNumbers.map((a) => a.n)).toEqual([1, 30, 31, 60, 61, 90]);
    for (const a of actionNumbers) {
      expect(a.sender).toBe(a.n - 1);
      expect(a.topic).toBe(a.n - 1);
    }

    // The buttons point at the saved digest_items rows for exactly those
    // numbers, and each of those rows is the right email.
    expect(buttonRows(post)).toEqual(['todo_item-1', 'todo_item-30', 'todo_item-31', 'todo_item-60', 'todo_item-61', 'todo_item-90']);
    const byNumber = new Map(seen.itemInserts.map((row) => [row.item_number, row]));
    for (const n of [1, 30, 31, 60, 61, 90]) {
      expect(byNumber.get(n).graph_message_id).toBe(`m-${n - 1}`);
    }

    // A real digest covered the window, so coverage moves forward.
    const meta = lastRunPatch(seen).metadata;
    expect(meta.coverage_end).toBeTruthy();
    expect(meta).toMatchObject({ triage_batches: 3, triage_retries: 0, action: 6 });
  });

  it('a batch that runs out of tokens is retried on its own, and the digest still posts', async () => {
    let failedOnce = false;
    const seen = setup({
      emails,
      lastCoverageEnd,
      triage: (call) => {
        const firstShown = shownEmails(call.user)[0].n;
        if (firstShown === 31 && !failedOnce) {
          failedOnce = true;
          return outOfTokens();
        }
        return perBatch(call);
      },
    });
    await runDigest();
    expect(seen.triageCalls).toHaveLength(4);
    const post = digestPost(seen);
    expect(post.text).not.toContain('Claude returned no digest text');
    expect(buttonRows(post)).toEqual(['todo_item-1', 'todo_item-30', 'todo_item-31', 'todo_item-60', 'todo_item-61', 'todo_item-90']);
    expect(lastRunPatch(seen).metadata).toMatchObject({ triage_batches: 3, triage_retries: 1 });
    expect(lastRunPatch(seen).metadata.coverage_end).toBeTruthy();
  });

  it('if any batch still fails after its retry, the whole run fails and coverage does NOT advance', async () => {
    const seen = setup({
      emails,
      lastCoverageEnd,
      triage: (call) => (shownEmails(call.user)[0].n === 61 ? outOfTokens() : perBatch(call)),
    });
    await runDigest();
    expect(digestPost(seen).text).toContain('Claude returned no digest text');
    expect(lastRunPatch(seen).metadata.coverage_end).toBeUndefined();
  });
});
