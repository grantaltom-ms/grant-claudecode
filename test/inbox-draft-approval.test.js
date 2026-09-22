import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import {
  executeTool,
  runAgent,
  looksLikeEmailSendApproval,
  isPhantomDraftApproval,
  PHANTOM_DRAFT_WARNING,
} from '../pages/api/inbox-assistant';
import { DRAFT_APPROVAL_FOOTER } from '../lib/inbox-blocks';

const TOKEN = 'test-graph-token';

// Captures every chat.postMessage the tool makes, so we can assert that the
// approval prompt Grant sees came from the tool rather than from model prose.
function captureSlackPosts() {
  const posts = [];
  server.use(
    http.post('https://slack.com/api/chat.postMessage', async ({ request }) => {
      posts.push(await request.json());
      return HttpResponse.json({ ok: true, ts: '111.222' });
    })
  );
  return posts;
}

function noMailTips() {
  return http.post('https://graph.microsoft.com/v1.0/users/:email/getMailTips', () =>
    HttpResponse.json({ value: [] })
  );
}

describe('the draft tools post their own approval card', () => {
  it('create_draft_reply posts the draft with recipients and the approval prompt', async () => {
    const posts = captureSlackPosts();
    server.use(
      noMailTips(),
      http.get('https://graph.microsoft.com/v1.0/users/:email/messages/:id', () =>
        HttpResponse.json({
          from: { emailAddress: { address: 'mia.skolnick@appfolio.com' } },
          ccRecipients: [{ emailAddress: { address: 'team@appfolio.com' } }],
        })
      ),
      http.post('https://graph.microsoft.com/v1.0/users/:email/messages/:id/createReply', () =>
        HttpResponse.json({ id: 'draft-99', subject: 'RE: Your New AppFolio Customer Success Manager' })
      )
    );

    const result = await executeTool('create_draft_reply', {
      message_id: 'msg-mia',
      body: 'Thanks Mia — happy to set up a call next week.',
    }, TOKEN, 'thread-ts');

    expect(result.draft_id).toBe('draft-99');
    expect(posts).toHaveLength(1);
    expect(posts[0].thread_ts).toBe('thread-ts');
    expect(posts[0].text).toContain('Your New AppFolio Customer Success Manager');
    expect(posts[0].text).toContain('To: mia.skolnick@appfolio.com');
    expect(posts[0].text).toContain('Cc: team@appfolio.com');
    expect(posts[0].text).toContain('happy to set up a call next week');
    expect(posts[0].text).toContain(DRAFT_APPROVAL_FOOTER);
  });

  it("tells the model not to repeat the draft or ask the approval question itself", async () => {
    captureSlackPosts();
    server.use(
      noMailTips(),
      http.post('https://graph.microsoft.com/v1.0/users/:email/messages', () =>
        HttpResponse.json({ id: 'draft-100', subject: 'Hello' })
      )
    );

    const result = await executeTool('create_new_draft', {
      to: ['vendor@example.com'],
      subject: 'Hello',
      body: 'Checking in.',
    }, TOKEN, 'thread-ts');

    expect(result.message).toMatch(/ONE short sentence/);
    expect(result.message).toMatch(/do NOT ask/i);
  });

  it('create_new_draft carries the first-time-recipient warning onto the card', async () => {
    const posts = captureSlackPosts();
    server.use(
      noMailTips(),
      http.post('https://graph.microsoft.com/v1.0/users/:email/messages', () =>
        HttpResponse.json({ id: 'draft-101', subject: 'Intro' })
      )
    );

    const result = await executeTool('create_new_draft', {
      to: ['brand.new@example.com'],
      subject: 'Intro',
      body: 'Nice to meet you.',
    }, TOKEN, 'thread-ts');

    // The fixture Supabase has no prior correspondence, so this recipient is new.
    expect(result.first_time_recipients).toEqual(['brand.new@example.com']);
    expect(posts[0].text).toContain('First time emailing brand.new@example.com');
  });

  it('skips the card when there is no thread to post it in, and still saves the draft', async () => {
    const posts = captureSlackPosts();
    server.use(
      noMailTips(),
      http.post('https://graph.microsoft.com/v1.0/users/:email/messages', () =>
        HttpResponse.json({ id: 'draft-102', subject: 'Hello' })
      )
    );

    const result = await executeTool('create_new_draft', {
      to: ['vendor@example.com'],
      subject: 'Hello',
      body: 'Checking in.',
    }, TOKEN, null);

    expect(result.draft_id).toBe('draft-102');
    expect(posts).toHaveLength(0);
  });

  it('a failing Slack post does not undo a draft that is already saved in Outlook', async () => {
    server.use(
      noMailTips(),
      http.post('https://slack.com/api/chat.postMessage', () =>
        HttpResponse.json({ ok: false, error: 'ratelimited' })
      ),
      http.post('https://graph.microsoft.com/v1.0/users/:email/messages', () =>
        HttpResponse.json({ id: 'draft-103', subject: 'Hello' })
      )
    );

    const result = await executeTool('create_new_draft', {
      to: ['vendor@example.com'],
      subject: 'Hello',
      body: 'Checking in.',
    }, TOKEN, 'thread-ts');

    expect(result.draft_id).toBe('draft-103');
  });
});

// The production failure this guards against: the model wrote a reply to Mia
// Skolnick in prose, asked "Send it, edit it, or discard?", and never called
// create_draft_reply -- so "Send it" found nothing in Drafts.
describe('phantom draft-approval detection', () => {
  it('flags the exact prompt the model used when it had staged nothing', () => {
    expect(isPhantomDraftApproval('Here is the draft.\n\nSend it, edit it, or discard?', ['search_emails']))
      .toBe(true);
  });

  it('does not flag it when a draft tool actually ran', () => {
    for (const tool of ['create_draft_reply', 'create_new_draft', 'get_recent_drafts', 'send_draft']) {
      expect(isPhantomDraftApproval('Send it, edit it, or discard?', ['search_emails', tool]))
        .toBe(false);
    }
  });

  it('leaves the calendar flow alone', () => {
    expect(looksLikeEmailSendApproval('Staged — use the buttons above to book, edit, or discard.'))
      .toBe(false);
    expect(isPhantomDraftApproval('Book it, edit it, or discard?', [])).toBe(false);
    expect(isPhantomDraftApproval('Staged — book, edit, or discard above.', ['propose_calendar_event']))
      .toBe(false);
  });

  it('ignores ordinary replies that mention neither sending nor discarding', () => {
    expect(looksLikeEmailSendApproval('')).toBe(false);
    expect(looksLikeEmailSendApproval('I archived that thread.')).toBe(false);
    expect(looksLikeEmailSendApproval('Want me to send it?')).toBe(false);
    expect(looksLikeEmailSendApproval('Discarded the old draft.')).toBe(false);
  });

  it('catches the wording variants of the same question', () => {
    expect(looksLikeEmailSendApproval('Send this, edit it, or discard?')).toBe(true);
    expect(looksLikeEmailSendApproval('Should I send the draft, or discard it?')).toBe(true);
  });
});

// Scripts the Anthropic endpoint turn by turn, so runAgent's loop can be
// driven through the exact sequence the production failure produced.
function scriptAnthropic(turns) {
  const remaining = [...turns];
  const seen = [];
  server.use(
    http.post('https://api.anthropic.com/v1/messages', async ({ request }) => {
      seen.push(await request.json());
      const turn = remaining.shift();
      if (!turn) throw new Error('runAgent asked for more turns than the test scripted');
      return HttpResponse.json({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: turn.content,
        stop_reason: turn.stop_reason,
      });
    })
  );
  return { seen, remaining };
}

const PHANTOM_TEXT = 'Here is the reply:\n\nHi Mia — thanks for reaching out.\n\nSend it, edit it, or discard?';

describe('runAgent refuses to ship a draft-approval prompt with no draft behind it', () => {
  it('makes the model save the draft instead of posting the phantom prompt', async () => {
    const posts = captureSlackPosts();
    server.use(
      noMailTips(),
      http.get('https://graph.microsoft.com/v1.0/users/:email/messages/:id', () =>
        HttpResponse.json({ from: { emailAddress: { address: 'mia.skolnick@appfolio.com' } }, ccRecipients: [] })
      ),
      http.post('https://graph.microsoft.com/v1.0/users/:email/messages/:id/createReply', () =>
        HttpResponse.json({ id: 'draft-recovered', subject: 'RE: AppFolio' })
      )
    );

    const { seen } = scriptAnthropic([
      { stop_reason: 'end_turn', content: [{ type: 'text', text: PHANTOM_TEXT }] },
      {
        stop_reason: 'tool_use',
        content: [{
          type: 'tool_use',
          id: 'toolu_1',
          name: 'create_draft_reply',
          input: { message_id: 'msg-mia', body: 'Hi Mia — thanks for reaching out.' },
        }],
      },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Drafted — details above.' }] },
    ]);

    await runAgent('reply to Mia Skolnick', 'thread-ts', []);

    // The phantom prompt never reached Slack; the tool-posted card did.
    const texts = posts.map(post => post.text);
    expect(texts.some(text => text.includes('Send it, edit it, or discard?'))).toBe(false);
    expect(texts.some(text => text.includes(DRAFT_APPROVAL_FOOTER))).toBe(true);
    expect(texts).toContain('Drafted — details above.');

    // The correction was delivered as an extra turn, not a silent retry.
    expect(seen).toHaveLength(3);
    const correctionTurn = seen[1].messages[seen[1].messages.length - 1];
    expect(correctionTurn.role).toBe('user');
    expect(correctionTurn.content).toMatch(/never called create_draft_reply or create_new_draft/);
  });

  it('warns Grant outright if the model still will not save a draft', async () => {
    const posts = captureSlackPosts();
    scriptAnthropic([
      { stop_reason: 'end_turn', content: [{ type: 'text', text: PHANTOM_TEXT }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: PHANTOM_TEXT }] },
    ]);

    await runAgent('reply to Mia Skolnick', 'thread-ts', []);

    expect(posts).toHaveLength(1);
    expect(posts[0].text).toContain(PHANTOM_DRAFT_WARNING);
  });

  it('corrects at most once, so a stubborn model cannot loop', async () => {
    captureSlackPosts();
    const { remaining } = scriptAnthropic([
      { stop_reason: 'end_turn', content: [{ type: 'text', text: PHANTOM_TEXT }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: PHANTOM_TEXT }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: PHANTOM_TEXT }] },
    ]);

    await runAgent('reply to Mia Skolnick', 'thread-ts', []);

    expect(remaining).toHaveLength(1);
  });

  it('posts a normal reply untouched', async () => {
    const posts = captureSlackPosts();
    scriptAnthropic([
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'You have 3 unread emails.' }] },
    ]);

    await runAgent('how many unread?', 'thread-ts', []);

    expect(posts).toHaveLength(1);
    expect(posts[0].text).toBe('You have 3 unread emails.');
  });
});
