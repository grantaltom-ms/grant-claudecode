import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import { runDigest } from '../pages/api/digest';
import { DIGEST_FIXTURE_EMAILS, SPAM_EMAIL_INDEX } from './fixtures/digest-emails';

function textResponse(text) {
  return HttpResponse.json({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
  });
}

// A digest run makes several distinct Claude calls (spam filter, thread
// summaries, entity extraction, final triage) that all hit the same
// endpoint -- this router replaces the harness default for the duration of
// the test so every call site gets a response tailored to this fixture set.
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
        '- [#1] Crystal Li — BECU Loan Documents [DUE SOON]: needs signature by Friday\n' +
        '- [#2] Rhoda — Stolen rents: urgent, needs immediate attention\n\n' +
        '*🟡 FYI / Needs Awareness*\n' +
        '- Merritt Hess — Renton Ave closing: review requested\n\n' +
        '14 emails total — 2 need action'
      );
    }
    return textResponse('(unhandled in digest-triage test)');
  });
}

describe('digest triage classification', () => {
  it('filters spam, surfaces the deadline email under Action Required, and omits automated noise', async () => {
    const posts = [];
    server.use(
      http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:folder/messages', () =>
        HttpResponse.json({ value: DIGEST_FIXTURE_EMAILS })
      ),
      digestAnthropicRouter(),
      http.post('https://slack.com/api/chat.postMessage', async ({ request }) => {
        const body = await request.json();
        posts.push(body.text);
        return HttpResponse.json({ ok: true, ts: `${1700000000 + posts.length}.000001` });
      })
    );

    await runDigest();

    expect(posts.length).toBeGreaterThan(0);
    const digest = posts.find(text => text.includes('Morning Digest'));
    expect(digest).toBeDefined();

    // Structure, not exact wording: the deadline email is present under Action Required...
    expect(digest).toContain('🔴 Action Required');
    expect(digest).toContain('BECU Loan Documents');

    // ...the obvious spam/cold-pitch sender never appears in the posted digest...
    expect(digest).not.toContain('Totally Legit Marketing');

    // ...and the footer reflects that spam was filtered (not archived, since
    // AUTO_ARCHIVE_SPAM isn't set in this test's environment).
    expect(digest).toMatch(/spam.*filtered from this digest; not archived/i);
  });

  it('flags a busy day above the volume cap in the digest footer', async () => {
    const manyEmails = Array.from({ length: 60 }, (_, i) => ({
      ...DIGEST_FIXTURE_EMAILS[i % DIGEST_FIXTURE_EMAILS.length],
      id: `bulk-${i}`,
      conversationId: `bulk-conv-${i}`,
    }));

    const posts = [];
    server.use(
      http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:folder/messages', () =>
        HttpResponse.json({ value: manyEmails })
      ),
      digestAnthropicRouter(),
      http.post('https://slack.com/api/chat.postMessage', async ({ request }) => {
        const body = await request.json();
        posts.push(body.text);
        return HttpResponse.json({ ok: true, ts: `${1700000000 + posts.length}.000001` });
      })
    );

    await runDigest();

    const digest = posts.find(text => text.includes('Morning Digest'));
    expect(digest).toBeDefined();
    expect(digest).toMatch(/Volume cap hit today/i);
  });
});
