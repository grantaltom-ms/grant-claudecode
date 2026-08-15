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

function fixtureEmail(overrides) {
  return {
    id: overrides.id,
    conversationId: `conv-${overrides.id}`,
    internetMessageId: `<${overrides.id}@example.com>`,
    subject: overrides.subject,
    from: { emailAddress: { name: overrides.senderName, address: overrides.senderEmail } },
    toRecipients: [{ emailAddress: { name: 'Grant Carlson', address: OWNER_EMAIL } }],
    ccRecipients: [],
    receivedDateTime: overrides.receivedDateTime || new Date().toISOString(),
    sentDateTime: overrides.receivedDateTime || new Date().toISOString(),
    isRead: false,
    hasAttachments: false,
    importance: 'normal',
    bodyPreview: overrides.bodyPreview,
    body: { contentType: 'text', content: overrides.bodyPreview },
    internetMessageHeaders: [{ name: 'Authentication-Results', value: 'spf=pass; dkim=pass; dmarc=pass' }],
  };
}

function historyMessage(overrides) {
  return {
    id: overrides.id,
    graph_message_id: overrides.id,
    graph_conversation_id: overrides.conversationId,
    folder: overrides.folder,
    subject: overrides.subject,
    sender_email: overrides.senderEmail,
    recipients: overrides.recipients || [],
    cc_recipients: [],
    received_at: overrides.receivedAt || null,
    sent_at: overrides.sentAt || null,
  };
}

// Sender A crosses the qualification threshold (3+ exchanges, at least one
// outbound): 2 prior inbound + 1 prior outbound, all dated before "today".
const FREQUENT_CONTACT_HISTORY = [
  historyMessage({ id: 'h1', conversationId: 'c-a-1', folder: 'Inbox', subject: 'BECU refi - step 1', senderEmail: 'crystal.li@becu.org', receivedAt: '2026-01-01T00:00:00Z' }),
  historyMessage({ id: 'h2', conversationId: 'c-a-2', folder: 'Inbox', subject: 'BECU refi - step 2', senderEmail: 'crystal.li@becu.org', receivedAt: '2026-01-05T00:00:00Z' }),
  historyMessage({
    id: 'h3', conversationId: 'c-a-2', folder: 'SentItems', subject: 'Re: BECU refi - step 2', senderEmail: OWNER_EMAIL,
    recipients: [{ emailAddress: { address: 'crystal.li@becu.org' } }], sentAt: '2026-01-06T00:00:00Z',
  }),
  // Sender B has only one prior inbound message -- below the threshold.
  historyMessage({ id: 'h4', conversationId: 'c-b-1', folder: 'Inbox', subject: 'One-off vendor question', senderEmail: 'vendor@onetime.example.com', receivedAt: '2026-01-03T00:00:00Z' }),
];

const TODAY_FROM_A = fixtureEmail({
  id: 'today-a',
  subject: 'BECU refi - signature needed',
  senderName: 'Crystal Li',
  senderEmail: 'crystal.li@becu.org',
  bodyPreview: 'Please sign the attached documents by Friday.',
});

const TODAY_FROM_B = fixtureEmail({
  id: 'today-b',
  subject: 'Another one-off question',
  senderName: 'Vendor',
  senderEmail: 'vendor@onetime.example.com',
  bodyPreview: 'Quick question about the invoice.',
});

function digestAnthropicRouter(capture) {
  return http.post('https://api.anthropic.com/v1/messages', async ({ request }) => {
    const body = await request.json();
    const system = typeof body.system === 'string' ? body.system : (body.system?.[0]?.text || '');

    if (system.includes('spam filter')) return textResponse('[]');
    if (system.includes('Extract durable business entities')) return textResponse('[]');
    if (system.includes('summarize business email threads')) {
      return textResponse(JSON.stringify({ current_summary: 'Test summary.', open_items: [], status: 'active' }));
    }
    if (system.includes('morning email triage assistant')) {
      capture.triagePrompt = body.messages[0].content;
      return textResponse(
        '*🌅 Morning Digest — Test Day*\n\n*🔴 Action Required*\n'
        + '- [#1] Crystal Li — BECU refi, 4th follow-up: signature needed by Friday\n'
        + '- [#2] Vendor — Another one-off question: needs a reply\n\n'
        + '2 emails total — 2 need action'
      );
    }
    return textResponse('(unhandled in digest-correspondent-history test)');
  });
}

describe('digest correspondent history enrichment', () => {
  it('adds a History: note to the triage prompt only for the sender that crosses the exchange threshold', async () => {
    const posts = [];
    const callOrder = [];
    const capture = {};

    server.use(
      http.get('https://test-project.supabase.co/rest/v1/inbox_delta_state', () => HttpResponse.json([])),
      http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:folder/messages', () =>
        HttpResponse.json({ value: [TODAY_FROM_A, TODAY_FROM_B] })
      ),
      http.get('https://test-project.supabase.co/rest/v1/email_messages', () => {
        callOrder.push('history_read');
        return HttpResponse.json(FREQUENT_CONTACT_HISTORY);
      }),
      http.post('https://test-project.supabase.co/rest/v1/email_messages', async ({ request }) => {
        callOrder.push('email_save_write');
        const saved = await request.json();
        return HttpResponse.json([{ ...saved, id: 'saved-row' }]);
      }),
      digestAnthropicRouter(capture),
      http.post('https://slack.com/api/chat.postMessage', async ({ request }) => {
        const body = await request.json();
        posts.push(body.text);
        return HttpResponse.json({ ok: true, ts: `${1700000000 + posts.length}.000001` });
      })
    );

    await runDigest();

    expect(capture.triagePrompt).toContain('crystal.li@becu.org');
    const lineA = capture.triagePrompt.split('\n').find(line => line.includes('crystal.li@becu.org'));
    const lineB = capture.triagePrompt.split('\n').find(line => line.includes('vendor@onetime.example.com'));
    expect(lineA).toContain('History:');
    expect(lineA).toContain('3 prior exchanges');
    expect(lineB).toBeDefined();
    expect(lineB).not.toContain('History:');

    const digest = posts.find(text => text.includes('Morning Digest'));
    expect(digest).toBeDefined();

    // Load-bearing ordering guarantee: correspondent history must be read
    // before today's own arrivals are saved into email_messages, or today's
    // arrival would count toward "prior" correspondence.
    expect(callOrder.indexOf('history_read')).toBeGreaterThanOrEqual(0);
    expect(callOrder.indexOf('email_save_write')).toBeGreaterThan(callOrder.indexOf('history_read'));
  });

  it('does not enrich any line when no sender crosses the threshold', async () => {
    const posts = [];
    const capture = {};

    server.use(
      http.get('https://test-project.supabase.co/rest/v1/inbox_delta_state', () => HttpResponse.json([])),
      http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:folder/messages', () =>
        HttpResponse.json({ value: [TODAY_FROM_B] })
      ),
      http.get('https://test-project.supabase.co/rest/v1/email_messages', () =>
        HttpResponse.json([historyMessage({ id: 'h4', conversationId: 'c-b-1', folder: 'Inbox', subject: 'One-off vendor question', senderEmail: 'vendor@onetime.example.com', receivedAt: '2026-01-03T00:00:00Z' })])
      ),
      digestAnthropicRouter(capture),
      http.post('https://slack.com/api/chat.postMessage', async ({ request }) => {
        const body = await request.json();
        posts.push(body.text);
        return HttpResponse.json({ ok: true, ts: `${1700000000 + posts.length}.000001` });
      })
    );

    await runDigest();

    expect(capture.triagePrompt).not.toContain('History:');
  });
});
