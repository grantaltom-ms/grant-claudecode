import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import { runDigest } from '../pages/api/digest';
import { EMAIL_ACTIONS } from '../lib/inbox-blocks';

function textResponse(text) {
  return HttpResponse.json({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
  });
}

function digestAnthropicRouter(digestText) {
  return http.post('https://api.anthropic.com/v1/messages', async ({ request }) => {
    const body = await request.json();
    const system = typeof body.system === 'string' ? body.system : (body.system?.[0]?.text || '');

    if (system.includes('spam filter')) return textResponse('[]');
    if (system.includes('Extract durable business entities')) return textResponse('[]');
    if (system.includes('summarize business email threads')) {
      return textResponse(JSON.stringify({ current_summary: 'Test summary.', open_items: [], status: 'active' }));
    }
    if (system.includes('morning email triage assistant')) return textResponse(digestText);
    return textResponse('(unhandled in digest-reply-buttons test)');
  });
}

function fixtureEmail(id, senderName, senderEmail, subject) {
  return {
    id,
    conversationId: `conv-${id}`,
    internetMessageId: `<${id}@example.com>`,
    subject,
    from: { emailAddress: { name: senderName, address: senderEmail } },
    toRecipients: [{ emailAddress: { name: 'Grant Carlson', address: 'grant@milestoneproperties.net' } }],
    ccRecipients: [],
    receivedDateTime: new Date().toISOString(),
    sentDateTime: new Date().toISOString(),
    isRead: false,
    hasAttachments: false,
    importance: 'normal',
    bodyPreview: `Preview for ${subject}`,
    body: { contentType: 'text', content: `Body for ${subject}` },
    internetMessageHeaders: [{ name: 'Authentication-Results', value: 'spf=pass; dkim=pass; dmarc=pass' }],
  };
}

const EMAILS = [
  fixtureEmail('e1', 'Harper Law', 'harper@example.com', 'Emergency motion filed on B-309'),
  fixtureEmail('e2', 'Scott Sanborn', 'scott@alliancelaundry.com', 'Re: Options for high end machines'),
  fixtureEmail('e3', 'Rhoda Carlson', 'rhoda@milestoneproperties.net', 'FW: Insurance renewal planning'),
];

const ACTIONABLE_DIGEST = `*🌅 Morning Digest — Test Day*

*🔴 Action Required*
- [#1] Harper Law — emergency motion filed, review and determine next steps
- [#2] Scott Sanborn — quote ready for signature

*🟡 FYI / Needs Awareness*
- Rhoda Carlson — insurance renewal planning

3 emails total — 2 need action`;

// The production failure: the model renumbered its Action Required items 1, 2
// instead of reusing each email's input-list number. [#1] here claims to be
// Scott Sanborn, but item 1 is Harper Law -- clicking would open a reply to
// the wrong correspondent.
const RENUMBERED_DIGEST = `*🌅 Morning Digest — Test Day*

*🔴 Action Required*
- [#1] Scott Sanborn — quote ready for signature
- [#2] Rhoda Carlson — insurance renewal planning

3 emails total — 2 need action`;

const NOTHING_ACTIONABLE_DIGEST = `*🌅 Morning Digest — Test Day*

*🟡 FYI / Needs Awareness*
- Rhoda Carlson — insurance renewal planning

3 emails total — 0 need action`;

function mockDigestNetwork(digestText, posts) {
  server.use(
    http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:folder/messages', () =>
      HttpResponse.json({ value: EMAILS })
    ),
    digestAnthropicRouter(digestText),
    // createDigestRun uses .select().single(), so this must be a single object,
    // not an array. Without a run id, saveDigestItems early-returns and there
    // would be no saved rows to verify the [#N] markers against.
    http.post('https://test-project.supabase.co/rest/v1/digest_runs', () =>
      HttpResponse.json({ id: 'run-test-1' })
    ),
    // saveDigestItems inserts with .select(), and the returned rows are what
    // the [#N] markers are verified against, so they have to come back.
    http.post('https://test-project.supabase.co/rest/v1/digest_items', async ({ request }) => {
      const inserted = await request.json();
      return HttpResponse.json(inserted);
    }),
    http.post('https://slack.com/api/chat.postMessage', async ({ request }) => {
      const body = await request.json();
      posts.push(body);
      return HttpResponse.json({ ok: true, ts: `${1700000000 + posts.length}.000001` });
    })
  );
}

describe('digest reply buttons', () => {
  it('posts one ✍️ Reply button per numbered Action Required item', async () => {
    const posts = [];
    mockDigestNetwork(ACTIONABLE_DIGEST, posts);

    await runDigest();

    const digestPost = posts.find(p => p.text?.includes('Morning Digest'));
    expect(digestPost).toBeDefined();

    const actionsBlocks = (digestPost.blocks || []).filter(b => b.type === 'actions');
    expect(actionsBlocks).toHaveLength(1);

    const elements = actionsBlocks[0].elements;
    expect(elements).toHaveLength(2);
    expect(elements.map(el => el.text.text)).toEqual(['✍️ Reply #1', '✍️ Reply #2']);
    expect(elements.map(el => JSON.parse(el.value))).toEqual([{ itemNumber: 1 }, { itemNumber: 2 }]);
    expect(elements.every(el => el.action_id.startsWith(EMAIL_ACTIONS.REPLY))).toBe(true);
  });

  it('keeps the full digest text as the message text, so nothing is lost if blocks are rejected', async () => {
    const posts = [];
    mockDigestNetwork(ACTIONABLE_DIGEST, posts);

    await runDigest();

    const digestPost = posts.find(p => p.text?.includes('Morning Digest'));
    expect(digestPost.text).toContain('[#1] Harper Law');
    expect(digestPost.text).toContain('[#2] Scott Sanborn');
    expect(digestPost.text).toContain('insurance renewal planning');
  });

  it('posts NO buttons when the model renumbered its items, rather than wiring them to the wrong emails', async () => {
    const posts = [];
    mockDigestNetwork(RENUMBERED_DIGEST, posts);

    await runDigest();

    const digestPost = posts.find(p => p.text?.includes('Morning Digest'));
    expect(digestPost).toBeDefined();
    // The digest itself still goes out in full -- only the buttons are withheld.
    expect(digestPost.text).toContain('[#1] Scott Sanborn');
    expect(digestPost.blocks).toBeUndefined();
  });

  it('posts no blocks at all when the digest has nothing actionable', async () => {
    const posts = [];
    mockDigestNetwork(NOTHING_ACTIONABLE_DIGEST, posts);

    await runDigest();

    const digestPost = posts.find(p => p.text?.includes('Morning Digest'));
    expect(digestPost).toBeDefined();
    expect(digestPost.blocks).toBeUndefined();
  });

  it('buttons ride on the digest message itself, so a click resolves against the digest thread', async () => {
    const posts = [];
    mockDigestNetwork(ACTIONABLE_DIGEST, posts);

    await runDigest();

    const digestPost = posts.find(p => p.text?.includes('Morning Digest'));
    // No thread_ts: this is the top-level digest message, whose own ts is what
    // digest_runs.slack_thread_ts stores and resolve_digest_item looks up.
    expect(digestPost.thread_ts).toBeUndefined();

    const followUp = posts.find(p => p.text?.includes('Reply'));
    expect(followUp).toBeDefined();
  });
});
