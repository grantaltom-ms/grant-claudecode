import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import { graphSentItemsHandler } from './mocks/handlers';
import { runDigest } from '../pages/api/digest';
import { DIGEST_FIXTURE_EMAILS, SPAM_EMAIL_INDEX } from './fixtures/digest-emails';

function textResponse(text) {
  return HttpResponse.json({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'thinking', thinking: '', signature: 'test-signature' }, { type: 'text', text }],
    stop_reason: 'end_turn',
  });
}

// A digest run makes several distinct Claude calls (spam filter, thread
// summaries, entity extraction, final triage) that all hit the same
// endpoint -- this router replaces the harness default for the duration of
// the test so every call site gets a response tailored to this fixture set.
//
// The fixture has 15 emails and #4 (index 3) is filtered as spam, so the model
// sees 14 and numbers them 1..14 in order: e1->1, e2->2, e3->3, e5->4, e6->5,
// e7->6, e8->7, e9->8, e10->9, e11->10, e12->11, e13->12, e14->13, e15->14.
function digestAnthropicRouter() {
  return http.post('https://api.anthropic.com/v1/messages', async ({ request }) => {
    const body = await request.json();
    const system = typeof body.system === 'string' ? body.system : (body.system?.[0]?.text || '');

    if (system.includes('spam filter')) {
      return textResponse(JSON.stringify([SPAM_EMAIL_INDEX]));
    }
    if (system.includes('Extract durable business entities')) {
      return textResponse('[]');
    }
    if (system.includes('summarize business email threads')) {
      return textResponse(JSON.stringify({ current_summary: 'Test summary.', open_items: [], status: 'active' }));
    }
    if (system.includes('morning email triage assistant')) {
      return textResponse(
        '*🌅 Morning Digest — Test Day*\n\n' +
        '*🔴 Action Required*\n' +
        '- [#4] Crystal Li — BECU Loan Documents [DUE SOON]: needs signature by Friday\n' +
        '- [#13] Rhoda — Stolen rents: urgent, needs immediate attention\n\n' +
        '*🟡 FYI / Needs Awareness*\n' +
        '- [#7] Merritt Hess — Renton Ave closing: review requested\n\n' +
        '14 emails total — 2 need action'
      );
    }
    return textResponse('(unhandled in digest-triage test)');
  });
}

function mockNetwork(emails, posts) {
  server.use(
    graphSentItemsHandler(),
    http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:folder/messages', () =>
      HttpResponse.json({ value: emails })
    ),
    digestAnthropicRouter(),
    http.post('https://slack.com/api/chat.postMessage', async ({ request }) => {
      const body = await request.json();
      posts.push(body);
      return HttpResponse.json({ ok: true, ts: `${1700000000 + posts.length}.000001` });
    })
  );
}

describe('digest triage classification', () => {
  it('posts Action Required only, filters spam and noise, and keeps must-show mail in a thread reply', async () => {
    const posts = [];
    mockNetwork(DIGEST_FIXTURE_EMAILS, posts);

    await runDigest();

    // Two posts: the digest, and one reply under it for the mail that must always appear.
    expect(posts).toHaveLength(2);
    const digest = posts[0].text;
    const thread = posts[1];
    expect(posts[0].thread_ts).toBeUndefined();
    expect(thread.thread_ts).toBe('1700000001.000001'); // under the digest, not a new top-level post

    // Structure, not exact wording: the deadline email is present under Action Required...
    expect(digest).toContain('Morning Digest');
    expect(digest).toContain('🔴 Action Required');
    expect(digest).toContain('BECU Loan Documents');
    expect(digest).not.toMatch(/undefined/);

    // ...and nothing else is in the main post: no Watching, FYI or Still open sections.
    expect(digest).not.toMatch(/Watching|FYI|Still open|Merritt Hess/);

    // ...the obvious spam/cold-pitch sender never appears anywhere...
    expect(digest).not.toContain('Totally Legit Marketing');
    expect(thread.text).not.toContain('Totally Legit Marketing');

    // ...automated noise never appears (the AppFolio reports, Adobe, the newsletter,
    // the Zapier error -- there is no System Alerts bucket any more)...
    expect(digest + thread.text).not.toMatch(/AppFolio daily report|owner statement|Adobe Acrobat|Weekly newsletter|Zapier|System Alerts/);

    // ...mail about money and insurance is guaranteed a place even though the model
    // said nothing about it: in the thread reply (the invoice, the W-9s, the insurance renewal)...
    expect(thread.text).toContain('Invoice #4471');
    expect(thread.text).toContain('Insurance renewal reminder');
    expect(thread.text).toContain('Psomas W-9 follow-up');
    expect(digest).not.toMatch(/Invoice #4471|Insurance renewal|Psomas/);

    // ...and the post ends after the last bucket: no count line, no footnotes.
    expect(digest + thread.text).not.toMatch(/emails total|need action|spam|filtered|archived|drafts/i);
  });

  it('adds no warning lines to the digest on a busy day (no volume-cap or too-much-mail note)', async () => {
    const manyEmails = Array.from({ length: 60 }, (_, i) => ({
      ...DIGEST_FIXTURE_EMAILS[i % DIGEST_FIXTURE_EMAILS.length],
      id: `bulk-${i}`,
      conversationId: `bulk-conv-${i}`,
    }));

    const posts = [];
    mockNetwork(manyEmails, posts);

    await runDigest();

    const digest = posts[0].text;
    // More threads than the memory caps allow, but that is no longer posted to Slack.
    expect(digest).not.toMatch(/Volume cap|Too much mail|not summarized|not scanned/i);
    // Regression (2026-09-29): Sonnet 5.5 replies start with a thinking block,
    // and reading content[0].text posted a bare "undefined" with the whole triage missing.
    expect(digest).not.toMatch(/undefined/);
    expect(digest).toContain('🔴 Action Required');
  });
});
