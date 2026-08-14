import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import { runDigest } from '../pages/api/digest';

const OWNER_EMAIL = 'grant@milestoneproperties.net';

function textResponse(text) {
  return HttpResponse.json({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
  });
}

function digestAnthropicRouter() {
  return http.post('https://api.anthropic.com/v1/messages', async ({ request }) => {
    const body = await request.json();
    const system = typeof body.system === 'string' ? body.system : (body.system?.[0]?.text || '');

    if (system.includes('spam filter')) return textResponse('[]');
    if (system.includes('Extract durable business entities')) return textResponse('[]');
    if (system.includes('summarize business email threads')) {
      return textResponse(JSON.stringify({ current_summary: 'Test summary.', open_items: [], status: 'active' }));
    }
    if (system.includes('morning email triage assistant')) {
      return textResponse(
        '*🌅 Morning Digest — Test Day*\n\n*🔴 Action Required*\n- [#1] Kelsey Dempsey — Unit 204 noise complaint: needs follow-up\n\n1 emails total — 1 need action'
      );
    }
    return textResponse('(unhandled in digest-delta-sync test)');
  });
}

function fixtureEmail(overrides) {
  return {
    id: overrides.id,
    conversationId: `conv-${overrides.id}`,
    internetMessageId: `<${overrides.id}@example.com>`,
    subject: overrides.subject,
    from: { emailAddress: { name: overrides.senderName, address: overrides.senderEmail } },
    toRecipients: [{ emailAddress: { name: 'Grant Carlson', address: OWNER_EMAIL } }],
    ccRecipients: [],
    receivedDateTime: overrides.receivedDateTime,
    sentDateTime: overrides.receivedDateTime,
    isRead: false,
    hasAttachments: false,
    importance: 'normal',
    bodyPreview: overrides.bodyPreview,
    body: { contentType: 'text', content: overrides.bodyPreview },
    internetMessageHeaders: [{ name: 'Authentication-Results', value: 'spf=pass; dkim=pass; dmarc=pass' }],
  };
}

function deltaStateHandler(row) {
  return http.get('https://test-project.supabase.co/rest/v1/inbox_delta_state', () =>
    HttpResponse.json(row ? [row] : [])
  );
}

function mockCommonNetwork(posts) {
  return [
    digestAnthropicRouter(),
    http.post('https://slack.com/api/chat.postMessage', async ({ request }) => {
      const body = await request.json();
      posts.push(body.text);
      return HttpResponse.json({ ok: true, ts: `${1700000000 + posts.length}.000001` });
    }),
  ];
}

const RECENT = fixtureEmail({
  id: 'recent-1',
  subject: 'Unit 204 noise complaint',
  senderName: 'Kelsey Dempsey',
  senderEmail: 'kelsey@milestoneproperties.net',
  bodyPreview: 'Tenant reported loud music again last night.',
  receivedDateTime: new Date().toISOString(),
});

describe('digest inbox fetch: delta sync', () => {
  it('uses the fixed-window fetch when no delta cursor is bootstrapped', async () => {
    const posts = [];
    server.use(
      deltaStateHandler(null),
      http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:folder/messages', () =>
        HttpResponse.json({ value: [RECENT] })
      ),
      ...mockCommonNetwork(posts)
      // Deliberately no handler for .../messages/delta -- onUnhandledRequest:
      // 'error' means the test fails hard if the delta path is hit instead.
    );

    await runDigest();

    const digest = posts.find(text => text.includes('Morning Digest'));
    expect(digest).toBeDefined();
    expect(digest).toContain('Unit 204 noise complaint');
  });

  it('uses delta fetch once bootstrapped, dropping @removed entries and anything outside the 24h window', async () => {
    const posts = [];
    const stale = fixtureEmail({
      id: 'stale-1',
      subject: 'Old thread nobody cares about anymore',
      senderName: 'Someone',
      senderEmail: 'someone@example.com',
      bodyPreview: 'This is old.',
      receivedDateTime: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    });
    let persistedCursor;

    server.use(
      deltaStateHandler({ owner_email: OWNER_EMAIL, cursor_url: 'https://graph.microsoft.com/v1.0/my-delta-cursor', is_bootstrapped: true }),
      http.get('https://graph.microsoft.com/v1.0/my-delta-cursor', () =>
        HttpResponse.json({
          value: [RECENT, stale, { id: 'removed-1', '@removed': { reason: 'deleted' } }],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/my-delta-cursor-next',
        })
      ),
      http.patch('https://test-project.supabase.co/rest/v1/inbox_delta_state', async ({ request }) => {
        persistedCursor = await request.json();
        return HttpResponse.json([]);
      }),
      ...mockCommonNetwork(posts)
      // No handler for the plain (non-delta) messages endpoint either --
      // proves the fixed-window path is not used when delta is active.
    );

    await runDigest();

    const digest = posts.find(text => text.includes('Morning Digest'));
    expect(digest).toBeDefined();
    expect(digest).toContain('Unit 204 noise complaint');
    expect(digest).not.toContain('Old thread nobody cares about anymore');
    expect(persistedCursor.cursor_url).toBe('https://graph.microsoft.com/v1.0/my-delta-cursor-next');
  });

  it('falls back to the fixed-window fetch and surfaces a resync note when the delta cursor has expired', async () => {
    const posts = [];
    let resetPayload;

    server.use(
      deltaStateHandler({ owner_email: OWNER_EMAIL, cursor_url: 'https://graph.microsoft.com/v1.0/expired-cursor', is_bootstrapped: true }),
      http.get('https://graph.microsoft.com/v1.0/expired-cursor', () =>
        HttpResponse.json({ error: { message: 'The delta token is expired.' } }, { status: 410 })
      ),
      http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:folder/messages', () =>
        HttpResponse.json({ value: [RECENT] })
      ),
      http.patch('https://test-project.supabase.co/rest/v1/inbox_delta_state', async ({ request }) => {
        resetPayload = await request.json();
        return HttpResponse.json([]);
      }),
      ...mockCommonNetwork(posts)
    );

    await runDigest();

    const digest = posts.find(text => text.includes('Morning Digest'));
    expect(digest).toBeDefined();
    expect(digest).toContain('Unit 204 noise complaint');
    expect(digest).toContain('Delta sync cursor expired');
    expect(resetPayload).toMatchObject({ cursor_url: null, is_bootstrapped: false, last_resync_reason: 'expired_410' });
  });
});
