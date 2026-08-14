import { describe, it, expect, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import { executeTool } from '../pages/api/inbox-assistant';

const TOKEN = 'test-graph-token';
const OWNER_EMAIL = 'grant@milestoneproperties.net';

describe('inbox-assistant send safety wiring', () => {
  afterEach(() => {
    delete process.env.MAX_SENDS_PER_DAY;
  });

  it('create_new_draft surfaces first_time_recipients for an address with no prior correspondence', async () => {
    server.use(
      http.get('https://test-project.supabase.co/rest/v1/email_messages', () => HttpResponse.json([])),
      http.post('https://graph.microsoft.com/v1.0/users/:email/messages', () =>
        HttpResponse.json({ id: 'draft-1', subject: 'Hello' })
      )
    );

    const result = await executeTool('create_new_draft', {
      to: ['newvendor@example.com'],
      subject: 'Hello',
      body: 'Hi there',
    }, TOKEN, 'thread-ts');

    expect(result.first_time_recipients).toEqual(['newvendor@example.com']);
  });

  it('create_new_draft omits first_time_recipients when the only recipient is on a trusted domain', async () => {
    server.use(
      http.post('https://graph.microsoft.com/v1.0/users/:email/messages', () =>
        HttpResponse.json({ id: 'draft-2', subject: 'Hello' })
      )
    );

    const result = await executeTool('create_new_draft', {
      to: ['kelsey@milestoneproperties.net'],
      subject: 'Hello',
      body: 'Hi there',
    }, TOKEN, 'thread-ts');

    expect(result.first_time_recipients).toBeUndefined();
  });

  it('create_draft_reply surfaces first_time_recipients from a new CC address', async () => {
    server.use(
      http.get('https://graph.microsoft.com/v1.0/users/:email/messages/:id', () =>
        HttpResponse.json({
          from: { emailAddress: { address: 'kelsey@milestoneproperties.net' } },
          ccRecipients: [{ emailAddress: { address: 'newcontact@example.com' } }],
        })
      ),
      http.get('https://test-project.supabase.co/rest/v1/email_messages', () => HttpResponse.json([]))
    );

    const result = await executeTool('create_draft_reply', {
      message_id: 'msg-1',
      body: 'Thanks!',
    }, TOKEN, 'thread-ts');

    expect(result.first_time_recipients).toEqual(['newcontact@example.com']);
  });

  it('send_draft is blocked once the daily send limit is reached', async () => {
    process.env.MAX_SENDS_PER_DAY = '0';

    const result = await executeTool('send_draft', { draft_id: 'draft-1' }, TOKEN, 'thread-ts');

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/daily send limit/i);
  });

  it('send_draft records a send_log row per recipient when allowed', async () => {
    let insertedBody;
    server.use(
      http.get('https://graph.microsoft.com/v1.0/users/:email/messages/:id', () =>
        HttpResponse.json({
          toRecipients: [{ emailAddress: { address: 'a@example.com' } }],
          ccRecipients: [{ emailAddress: { address: 'b@example.com' } }],
        })
      ),
      http.post('https://test-project.supabase.co/rest/v1/send_log', async ({ request }) => {
        insertedBody = await request.json();
        return HttpResponse.json([]);
      })
    );

    const result = await executeTool('send_draft', { draft_id: 'draft-9' }, TOKEN, 'thread-ts');

    expect(result.success).toBe(true);
    expect(insertedBody).toEqual([
      { owner_email: OWNER_EMAIL, recipient: 'a@example.com', message_id: 'draft-9' },
      { owner_email: OWNER_EMAIL, recipient: 'b@example.com', message_id: 'draft-9' },
    ]);
  });
});
