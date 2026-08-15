import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import { runSentMailBackfill } from '../pages/api/backfill-sent-mail';

const OWNER_EMAIL = 'grant@milestoneproperties.net';

const SENT_EMAIL = {
  id: 'sent-1',
  conversationId: 'conv-1',
  internetMessageId: '<sent-1@example.com>',
  subject: 'Re: Loan documents',
  from: { emailAddress: { name: 'Grant Carlson', address: OWNER_EMAIL } },
  toRecipients: [{ emailAddress: { name: 'Crystal Li', address: 'crystal.li@becu.org' } }],
  ccRecipients: [],
  receivedDateTime: '2026-01-02T00:00:00Z',
  sentDateTime: '2026-01-02T00:00:00Z',
  isRead: true,
  hasAttachments: false,
  importance: 'normal',
  bodyPreview: 'Sounds good, sending the signed docs back today.',
  body: { contentType: 'text', content: 'Sounds good, sending the signed docs back today.' },
};

describe('runSentMailBackfill', () => {
  it('saves SentItems messages to email_messages and upserts email_threads with the recipient', async () => {
    let savedEmailMessage;
    let upsertedThread;
    server.use(
      http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:folder/messages', () =>
        HttpResponse.json({ value: [SENT_EMAIL] })
      ),
      http.post('https://test-project.supabase.co/rest/v1/email_messages', async ({ request }) => {
        savedEmailMessage = await request.json();
        return HttpResponse.json([{ ...savedEmailMessage, id: 'row-1' }]);
      }),
      http.get('https://test-project.supabase.co/rest/v1/email_threads', () => HttpResponse.json([])),
      http.post('https://test-project.supabase.co/rest/v1/email_threads', async ({ request }) => {
        upsertedThread = await request.json();
        return HttpResponse.json([{ ...upsertedThread, id: 'thread-1' }]);
      })
    );

    const result = await runSentMailBackfill({ days: 3, maxMessages: 50 });

    expect(result.ok).toBe(true);
    expect(result.fetched).toBe(1);
    expect(result.saved_emails).toBe(1);
    expect(result.updated_threads).toBe(1);

    expect(savedEmailMessage.folder).toBe('SentItems');
    expect(savedEmailMessage.sender_email).toBe(OWNER_EMAIL);

    expect(upsertedThread.participant_emails).toEqual(expect.arrayContaining([OWNER_EMAIL, 'crystal.li@becu.org']));
  });

  it('counts save failures without throwing, and does not attempt a thread upsert for them', async () => {
    let threadUpsertCalled = false;
    server.use(
      http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:folder/messages', () =>
        HttpResponse.json({ value: [SENT_EMAIL] })
      ),
      http.post('https://test-project.supabase.co/rest/v1/email_messages', () =>
        HttpResponse.json({ message: 'boom' }, { status: 500 })
      ),
      http.post('https://test-project.supabase.co/rest/v1/email_threads', () => {
        threadUpsertCalled = true;
        return HttpResponse.json([]);
      })
    );

    const result = await runSentMailBackfill({ days: 3, maxMessages: 50 });

    expect(result.ok).toBe(false);
    expect(result.saved_emails).toBe(0);
    expect(result.error_count).toBe(1);
    expect(threadUpsertCalled).toBe(false);
  });
});
