import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { getGraphToken } from '../../lib/graph';
import { importMessage, exportMessageMime } from '../../lib/mail-import';

const OWNER = 'grant@milestoneproperties.net';

describe('importMessage', () => {
  it('preserves the original receivedDateTime/sentDateTime on create', async () => {
    let requestBody;
    server.use(
      http.post('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:folder/messages', async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({ id: 'imported-1', subject: requestBody.subject, receivedDateTime: requestBody.receivedDateTime });
      })
    );

    const token = await getGraphToken();
    const result = await importMessage(token, OWNER, 'archive', {
      subject: 'Old lease correspondence',
      bodyText: 'Forwarded from the legacy system.',
      fromAddress: 'tenant@example.com',
      receivedDateTime: '2019-03-12T09:00:00.000Z',
    });

    expect(result.id).toBe('imported-1');
    expect(requestBody.isDraft).toBe(false);
    expect(requestBody.receivedDateTime).toBe('2019-03-12T09:00:00.000Z');
    expect(requestBody.sentDateTime).toBe('2019-03-12T09:00:00.000Z');
    expect(requestBody.from).toEqual({ emailAddress: { address: 'tenant@example.com', name: 'tenant@example.com' } });
  });

  it('throws without receivedDateTime rather than silently stamping today', async () => {
    const token = await getGraphToken();
    await expect(importMessage(token, OWNER, 'archive', {
      subject: 'No date',
      bodyText: 'x',
    })).rejects.toThrow('receivedDateTime');
  });
});

describe('exportMessageMime', () => {
  it('returns the raw MIME body as text, not JSON', async () => {
    const mime = 'From: a@example.com\r\nSubject: Test\r\n\r\nBody text';
    server.use(
      http.get('https://graph.microsoft.com/v1.0/users/:email/messages/:id/$value', () =>
        new HttpResponse(mime, { headers: { 'Content-Type': 'text/plain' } })
      )
    );

    const token = await getGraphToken();
    const result = await exportMessageMime(token, OWNER, 'msg-1');
    expect(result).toBe(mime);
  });

  it('throws with the status on a failed export', async () => {
    server.use(
      http.get('https://graph.microsoft.com/v1.0/users/:email/messages/:id/$value', () =>
        new HttpResponse('Not found', { status: 404 })
      )
    );

    const token = await getGraphToken();
    await expect(exportMessageMime(token, OWNER, 'missing')).rejects.toThrow('404');
  });
});
