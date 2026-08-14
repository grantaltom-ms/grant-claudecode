import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import { runDigest } from '../pages/api/digest';

function textResponse(text) {
  return HttpResponse.json({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
  });
}

// The model's spam filter never flags either fixture email here -- the point
// of this test is that the deterministic auth-forensics banner catches the
// spoofed-vendor case regardless of what the LLM call decides.
function authForensicsAnthropicRouter() {
  return http.post('https://api.anthropic.com/v1/messages', async ({ request }) => {
    const body = await request.json();
    const system = typeof body.system === 'string' ? body.system : (body.system?.[0]?.text || '');

    if (system.includes('spam filter')) {
      return textResponse('[]');
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
        '- [#1] GreenScape Landscaping — Updated banking details for invoice payment: please review\n\n' +
        '*🟡 FYI / Needs Awareness*\n' +
        '- Kelsey Dempsey — Unit 204 noise complaint\n\n' +
        '2 emails total — 1 needs action'
      );
    }
    return textResponse('(unhandled in digest-auth-forensics test)');
  });
}

function fixtureEmail(overrides) {
  return {
    id: overrides.id,
    conversationId: `conv-${overrides.id}`,
    internetMessageId: `<${overrides.id}@example.com>`,
    subject: overrides.subject,
    from: { emailAddress: { name: overrides.senderName, address: overrides.senderEmail } },
    toRecipients: [{ emailAddress: { name: 'Grant Carlson', address: 'grant@milestoneproperties.net' } }],
    ccRecipients: [],
    receivedDateTime: new Date().toISOString(),
    sentDateTime: new Date().toISOString(),
    isRead: false,
    hasAttachments: false,
    importance: 'normal',
    bodyPreview: overrides.bodyPreview,
    body: { contentType: 'text', content: overrides.bodyPreview },
    internetMessageHeaders: [{ name: 'Authentication-Results', value: overrides.authResults }],
  };
}

const SPOOFED_VENDOR_EMAIL = fixtureEmail({
  id: 'auth-fail-1',
  subject: 'Updated banking details for invoice payment',
  senderName: 'GreenScape Landscaping',
  senderEmail: 'billing@greenscapewa.com',
  bodyPreview: 'Please note our bank account number and routing number have changed — update your records before the next payment.',
  authResults: 'spf=fail (sender IP is 203.0.113.9) smtp.mailfrom=greenscapewa-billing.ru; dkim=none; dmarc=fail action=quarantine header.from=greenscapewa.com',
});

const CLEAN_EMAIL = fixtureEmail({
  id: 'clean-1',
  subject: 'Unit 204 - noise complaint from neighbor',
  senderName: 'Kelsey Dempsey',
  senderEmail: 'kelsey@milestoneproperties.net',
  bodyPreview: 'Tenant in unit 203 reported loud music from 204 again last night.',
  authResults: 'spf=pass smtp.mailfrom=milestoneproperties.net; dkim=pass; dmarc=pass action=none',
});

function mockDigestNetwork(emails, posts) {
  server.use(
    http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:folder/messages', () =>
      HttpResponse.json({ value: emails })
    ),
    authForensicsAnthropicRouter(),
    http.post('https://slack.com/api/chat.postMessage', async ({ request }) => {
      const body = await request.json();
      posts.push(body.text);
      return HttpResponse.json({ ok: true, ts: `${1700000000 + posts.length}.000001` });
    })
  );
}

describe('digest auth forensics', () => {
  it('prepends a deterministic auth-failure banner for a spoofed vendor payment-change email', async () => {
    const posts = [];
    mockDigestNetwork([SPOOFED_VENDOR_EMAIL, CLEAN_EMAIL], posts);

    await runDigest();

    const digest = posts.find(text => text.includes('Morning Digest'));
    expect(digest).toBeDefined();
    expect(digest).toContain('AUTHENTICATION FAILURE DETECTED');
    expect(digest).toContain('Updated banking details for invoice payment');
    expect(digest).toContain('spf=fail');
    expect(digest).toContain('dmarc=fail');
  });

  it('does not add the banner when auth passes cleanly', async () => {
    const posts = [];
    mockDigestNetwork([CLEAN_EMAIL], posts);

    await runDigest();

    const digest = posts.find(text => text.includes('Morning Digest'));
    expect(digest).toBeDefined();
    expect(digest).not.toContain('AUTHENTICATION FAILURE DETECTED');
  });

  it('does not add the banner when auth fails but nothing asks to change payment details', async () => {
    const posts = [];
    const authFailNoPayment = fixtureEmail({
      id: 'auth-fail-2',
      subject: 'Following up on the W-9 request',
      senderName: 'Shannon Jensvold',
      senderEmail: 'shannon@psomas.com',
      bodyPreview: 'Just checking in on the W-9 request from last week.',
      authResults: 'spf=fail smtp.mailfrom=psomas-mail.ru; dkim=none; dmarc=fail action=quarantine',
    });
    mockDigestNetwork([authFailNoPayment], posts);

    await runDigest();

    const digest = posts.find(text => text.includes('Morning Digest'));
    expect(digest).toBeDefined();
    expect(digest).not.toContain('AUTHENTICATION FAILURE DETECTED');
  });
});
