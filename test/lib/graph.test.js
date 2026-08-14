import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { getGraphToken, graph, getMailTips, summarizeMailTips } from '../../lib/graph';

describe('lib/graph', () => {
  it('fetches and returns a token', async () => {
    const token = await getGraphToken();
    expect(token).toBe('test-graph-token');
  });

  it('makes an authenticated request against a relative path', async () => {
    const token = await getGraphToken();
    const result = await graph(token, '/users/test@example.com/mailFolders/Inbox/messages');
    expect(result.value).toEqual([]);
  });
});

describe('getMailTips', () => {
  it('posts EmailAddresses and the expected MailTipsOptions', async () => {
    let requestBody;
    server.use(
      http.post('https://graph.microsoft.com/v1.0/users/:email/getMailTips', async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({ value: [{ emailAddress: { address: 'a@example.com' } }] });
      })
    );

    const token = await getGraphToken();
    const tips = await getMailTips(token, 'grant@milestoneproperties.net', ['a@example.com']);

    expect(requestBody).toEqual({
      EmailAddresses: ['a@example.com'],
      MailTipsOptions: 'automaticReplies,mailboxFullStatus,deliveryRestriction',
    });
    expect(tips).toEqual([{ emailAddress: { address: 'a@example.com' } }]);
  });

  it('returns [] without making a request when there are no recipients', async () => {
    const token = await getGraphToken();
    const tips = await getMailTips(token, 'grant@milestoneproperties.net', []);
    expect(tips).toEqual([]);
  });
});

describe('summarizeMailTips', () => {
  it('notes an active out-of-office reply', () => {
    const notes = summarizeMailTips([
      { emailAddress: { address: 'a@example.com' }, automaticReplies: { message: 'Out until Friday' } },
    ]);
    expect(notes).toEqual(['a@example.com has an out-of-office reply active: "Out until Friday"']);
  });

  it('notes a full mailbox', () => {
    const notes = summarizeMailTips([{ emailAddress: { address: 'a@example.com' }, mailboxFull: true }]);
    expect(notes).toEqual(["a@example.com's mailbox appears full"]);
  });

  it('notes a delivery restriction', () => {
    const notes = summarizeMailTips([{ emailAddress: { address: 'a@example.com' }, deliveryRestricted: true }]);
    expect(notes).toEqual(['a@example.com may have delivery restrictions — message could be rejected']);
  });

  it('produces no notes for a clean recipient', () => {
    const notes = summarizeMailTips([{ emailAddress: { address: 'a@example.com' } }]);
    expect(notes).toEqual([]);
  });

  it('skips a per-recipient error entry rather than surfacing it as a warning', () => {
    const notes = summarizeMailTips([
      { emailAddress: { address: 'a@example.com' }, error: { message: 'mail tips unsupported for this domain' }, mailboxFull: true },
    ]);
    expect(notes).toEqual([]);
  });

  it('handles an empty or missing tips array', () => {
    expect(summarizeMailTips([])).toEqual([]);
    expect(summarizeMailTips(undefined)).toEqual([]);
  });
});
