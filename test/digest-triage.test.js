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
      posts.push(body.text);
      return HttpResponse.json({ ok: true, ts: `${1700000000 + posts.length}.000001` });
    })
  );
}

describe('digest triage classification', () => {
  it('filters spam, surfaces the deadline email under Action Required, and omits automated noise', async () => {
    const posts = [];
    mockNetwork(DIGEST_FIXTURE_EMAILS, posts);

    await runDigest();

    // Exactly one post: the digest. No follow-up message about the buttons.
    expect(posts).toHaveLength(1);
    const digest = posts[0];
    expect(digest).toContain('Morning Digest');

    // Structure, not exact wording: the deadline email is present under Action Required...
    expect(digest).toContain('🔴 Action Required');
    expect(digest).toContain('BECU Loan Documents');
    expect(digest).not.toMatch(/undefined/);

    // ...the obvious spam/cold-pitch sender never appears in the posted digest...
    expect(digest).not.toContain('Totally Legit Marketing');

    // ...automated noise never appears (the AppFolio reports, Adobe, the newsletter,
    // the Zapier error -- there is no System Alerts bucket any more)...
    expect(digest).not.toMatch(/AppFolio daily report|owner statement|Adobe Acrobat|Weekly newsletter|Zapier/);
    expect(digest).not.toContain('System Alerts');

    // ...mail about money and insurance is guaranteed a place even though the model
    // said nothing about it (the invoice, the W-9s, the insurance renewal)...
    expect(digest).toContain('Invoice #4471');
    expect(digest).toContain('Insurance renewal reminder');
    expect(digest).toContain('Psomas W-9 follow-up');

    // ...and the post ends after the last bucket: no count line, no spam footnote.
    expect(digest).not.toMatch(/emails total|need action|spam|filtered|archived|drafts/i);
  });

  it('flags a busy day above the volume cap in the digest footer', async () => {
    const manyEmails = Array.from({ length: 60 }, (_, i) => ({
      ...DIGEST_FIXTURE_EMAILS[i % DIGEST_FIXTURE_EMAILS.length],
      id: `bulk-${i}`,
      conversationId: `bulk-conv-${i}`,
    }));

    const posts = [];
    mockNetwork(manyEmails, posts);

    await runDigest();

    const digest = posts.find(text => text.includes('Morning Digest'));
    expect(digest).toBeDefined();
    expect(digest).toMatch(/Volume cap hit today/i);
    // 60 emails in a 24-hour window is more than the 50 the window allows: say so.
    expect(digest).toMatch(/Too much mail for one pass: only the newest 50 emails/);
    // Regression (2026-09-29): Sonnet 5.5 replies start with a thinking block,
    // and reading content[0].text posted the cap note under a bare "undefined"
    // with the whole triage missing.
    expect(digest).not.toMatch(/undefined/);
    expect(digest).toContain('🔴 Action Required');
  });
});
