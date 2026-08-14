import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { getGraphToken, graph, getMailTips, summarizeMailTips, walkDeltaPages } from '../../lib/graph';

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

describe('walkDeltaPages', () => {
  it('stops at a single page when Graph returns deltaLink immediately', async () => {
    server.use(
      http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:folder/messages/delta', () =>
        HttpResponse.json({
          value: [{ id: 'm1' }, { id: 'm2' }],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta-cursor-1',
        })
      )
    );

    const token = await getGraphToken();
    const result = await walkDeltaPages(token, '/users/grant@milestoneproperties.net/mailFolders/Inbox/messages/delta');

    expect(result.items).toEqual([{ id: 'm1' }, { id: 'm2' }]);
    expect(result.deltaLink).toBe('https://graph.microsoft.com/v1.0/delta-cursor-1');
    expect(result.nextLink).toBeNull();
    expect(result.pages).toBe(1);
  });

  it('follows @odata.nextLink across pages until deltaLink appears', async () => {
    server.use(
      http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:folder/messages/delta', () =>
        HttpResponse.json({
          value: [{ id: 'page1-item' }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/delta-page-2',
        })
      ),
      http.get('https://graph.microsoft.com/v1.0/delta-page-2', () =>
        HttpResponse.json({
          value: [{ id: 'page2-item' }],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta-cursor-final',
        })
      )
    );

    const token = await getGraphToken();
    const result = await walkDeltaPages(token, '/users/grant@milestoneproperties.net/mailFolders/Inbox/messages/delta');

    expect(result.items.map(i => i.id)).toEqual(['page1-item', 'page2-item']);
    expect(result.deltaLink).toBe('https://graph.microsoft.com/v1.0/delta-cursor-final');
    expect(result.pages).toBe(2);
  });

  it('stops at maxPages as a runaway guard and returns nextLink for the caller to resume from', async () => {
    server.use(
      http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:folder/messages/delta', () =>
        HttpResponse.json({ value: [{ id: 'a' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/loop-next' })
      ),
      http.get('https://graph.microsoft.com/v1.0/loop-next', () =>
        HttpResponse.json({ value: [{ id: 'b' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/loop-next' })
      )
    );

    const token = await getGraphToken();
    const result = await walkDeltaPages(token, '/users/grant@milestoneproperties.net/mailFolders/Inbox/messages/delta', { maxPages: 3 });

    expect(result.pages).toBe(3);
    expect(result.deltaLink).toBeNull();
    expect(result.nextLink).toBe('https://graph.microsoft.com/v1.0/loop-next');
  });

  it('resumes from an absolute startUrl without re-prefixing it', async () => {
    server.use(
      http.get('https://graph.microsoft.com/v1.0/resume-here', () =>
        HttpResponse.json({ value: [{ id: 'resumed' }], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/final' })
      )
    );

    const token = await getGraphToken();
    const result = await walkDeltaPages(token, 'https://graph.microsoft.com/v1.0/resume-here', { startIsAbsolute: true });

    expect(result.items).toEqual([{ id: 'resumed' }]);
    expect(result.deltaLink).toBe('https://graph.microsoft.com/v1.0/final');
  });
});
