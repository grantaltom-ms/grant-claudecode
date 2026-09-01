import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import { executeTool } from '../pages/api/inbox-assistant';

const TOKEN = 'test-graph-token';

describe('inbox-assistant historical import/export', () => {
  it('import_historical_email files into Archive by default with the original date preserved', async () => {
    let requestBody;
    server.use(
      http.post('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:folder/messages', async ({ request, params }) => {
        requestBody = await request.json();
        expect(params.folder).toBe('archive');
        return HttpResponse.json({ id: 'imported-1', subject: requestBody.subject, receivedDateTime: requestBody.receivedDateTime });
      })
    );

    const result = await executeTool('import_historical_email', {
      subject: 'Old lease correspondence',
      body: 'Forwarded from the legacy system.',
      from_address: 'tenant@example.com',
      received_at: '2019-03-12T09:00:00',
    }, TOKEN, 'thread-ts');

    expect(result.success).toBe(true);
    expect(result.message_id).toBe('imported-1');
    expect(requestBody.receivedDateTime).toBe(new Date('2019-03-12T09:00:00').toISOString());
  });

  it('import_historical_email respects an explicit destination folder', async () => {
    let folderParam;
    server.use(
      http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:parent/childFolders', () =>
        HttpResponse.json({ value: [{ id: 'needs-reply-id', displayName: 'Needs Reply' }] })
      ),
      http.post('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:folder/messages', async ({ params }) => {
        folderParam = params.folder;
        return HttpResponse.json({ id: 'imported-2' });
      })
    );

    await executeTool('import_historical_email', {
      subject: 'Old thread',
      body: 'x',
      from_address: 'a@example.com',
      received_at: '2020-01-01T00:00:00',
      folder: 'needs_reply',
    }, TOKEN, 'thread-ts');

    expect(folderParam).toBe('needs-reply-id');
  });

  it('export_email_mime returns raw MIME text', async () => {
    const mime = 'From: a@example.com\r\nSubject: Test\r\n\r\nBody text';
    server.use(
      http.get('https://graph.microsoft.com/v1.0/users/:email/messages/:id/$value', () => new HttpResponse(mime))
    );

    const result = await executeTool('export_email_mime', { message_id: 'msg-1' }, TOKEN, 'thread-ts');

    expect(result.mime).toBe(mime);
    expect(result.truncated).toBe(false);
    expect(result.total_length).toBe(mime.length);
  });

  it('export_email_mime truncates a very large message and flags it', async () => {
    const mime = 'X'.repeat(25000);
    server.use(
      http.get('https://graph.microsoft.com/v1.0/users/:email/messages/:id/$value', () => new HttpResponse(mime))
    );

    const result = await executeTool('export_email_mime', { message_id: 'msg-2' }, TOKEN, 'thread-ts');

    expect(result.truncated).toBe(true);
    expect(result.mime.length).toBe(20000);
    expect(result.total_length).toBe(25000);
  });
});
