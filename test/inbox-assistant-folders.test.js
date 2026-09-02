import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import { executeTool } from '../pages/api/inbox-assistant';

const TOKEN = 'test-graph-token';

describe('inbox-assistant native mail folders', () => {
  it('list_mail_folders returns id/name/counts', async () => {
    server.use(
      http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders', () =>
        HttpResponse.json({
          value: [{ id: 'f1', displayName: 'Inbox', unreadItemCount: 3, totalItemCount: 40 }],
        })
      )
    );

    const result = await executeTool('list_mail_folders', {}, TOKEN, 'thread-ts');
    expect(result.folders).toEqual([{ id: 'f1', name: 'Inbox', unread: 3, total: 40 }]);
  });

  it('create_mail_folder creates a top-level folder', async () => {
    server.use(
      http.post('https://graph.microsoft.com/v1.0/users/:email/mailFolders', async ({ request }) => {
        const body = await request.json();
        return HttpResponse.json({ id: 'f2', displayName: body.displayName });
      })
    );

    const result = await executeTool('create_mail_folder', { display_name: 'Acme Corp' }, TOKEN, 'thread-ts');
    expect(result.folder).toEqual({ id: 'f2', name: 'Acme Corp' });
  });

  it('move_email_to_folder resolves a triage folder (creating it if needed) and moves the message', async () => {
    let moveBody;
    server.use(
      http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:parent/childFolders', () =>
        HttpResponse.json({ value: [] })
      ),
      http.post('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:parent/childFolders', async ({ request }) => {
        const body = await request.json();
        return HttpResponse.json({ id: 'waiting-on-id', displayName: body.displayName });
      }),
      http.post('https://graph.microsoft.com/v1.0/users/:email/messages/:id/move', async ({ request }) => {
        moveBody = await request.json();
        return HttpResponse.json({ id: 'msg-1' });
      })
    );

    const result = await executeTool('move_email_to_folder', { message_id: 'msg-1', folder: 'waiting_on' }, TOKEN, 'thread-ts');

    expect(moveBody).toEqual({ destinationId: 'waiting-on-id' });
    expect(result.folder).toBe('Waiting On');
    expect(result.success).toBe(true);
  });

  it('move_email_to_folder resolves well-known folders (archive/inbox) directly, without a folder lookup', async () => {
    let moveBody;
    server.use(
      http.post('https://graph.microsoft.com/v1.0/users/:email/messages/:id/move', async ({ request }) => {
        moveBody = await request.json();
        return HttpResponse.json({ id: 'msg-2' });
      })
    );

    const result = await executeTool('move_email_to_folder', { message_id: 'msg-2', folder: 'archive' }, TOKEN, 'thread-ts');

    expect(moveBody).toEqual({ destinationId: 'archive' });
    expect(result.success).toBe(true);
  });
});

describe('inbox-assistant digest triage files real Outlook folders', () => {
  function mockDigestItemLookup({ actionStatus = 'open' } = {}) {
    server.use(
      http.get('https://test-project.supabase.co/rest/v1/digest_runs', () =>
        HttpResponse.json([{ id: 'run-1', slack_thread_ts: 'thread-ts', run_started_at: '2026-09-01T08:00:00Z', status: 'ok' }])
      ),
      http.get('https://test-project.supabase.co/rest/v1/digest_items', () =>
        HttpResponse.json([{
          id: 'item-1',
          item_number: 1,
          graph_message_id: 'msg-1',
          graph_conversation_id: null,
          sender_name: 'Crystal Li',
          sender_email: 'crystal.li@becu.org',
          subject: 'Financials needed',
          received_at: '2026-09-01T07:00:00Z',
          classification: 'action_required',
          action_status: actionStatus,
          raw_digest_input: {},
        }])
      ),
      http.get('https://test-project.supabase.co/rest/v1/email_messages', () => HttpResponse.json([])),
      http.patch('https://test-project.supabase.co/rest/v1/digest_items', () => HttpResponse.json([]))
    );
  }

  it('moves the underlying email into the Waiting On folder when marked waiting', async () => {
    mockDigestItemLookup();
    let moveBody;
    server.use(
      http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:parent/childFolders', () =>
        HttpResponse.json({ value: [{ id: 'waiting-on-id', displayName: 'Waiting On' }] })
      ),
      http.post('https://graph.microsoft.com/v1.0/users/:email/messages/:id/move', async ({ request }) => {
        moveBody = await request.json();
        return HttpResponse.json({ id: 'msg-1' });
      })
    );

    const result = await executeTool('update_digest_item_status', { item_number: 1, action_status: 'waiting' }, TOKEN, 'thread-ts');

    expect(result.filed_to).toBe('Waiting On');
    expect(moveBody).toEqual({ destinationId: 'waiting-on-id' });
  });

  it('does not move anything for a status with no folder mapping (open)', async () => {
    mockDigestItemLookup({ actionStatus: 'open' });
    let moveCalled = false;
    server.use(
      http.post('https://graph.microsoft.com/v1.0/users/:email/messages/:id/move', () => {
        moveCalled = true;
        return HttpResponse.json({ id: 'msg-1' });
      })
    );

    const result = await executeTool('update_digest_item_status', { item_number: 1, action_status: 'open' }, TOKEN, 'thread-ts');

    expect(result.filed_to).toBeUndefined();
    expect(moveCalled).toBe(false);
  });

  it('does not fail the status update if the folder move fails', async () => {
    mockDigestItemLookup();
    server.use(
      http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:parent/childFolders', () =>
        HttpResponse.json({ error: { message: 'Forbidden' } }, { status: 403 })
      )
    );

    const result = await executeTool('update_digest_item_status', { item_number: 1, action_status: 'waiting' }, TOKEN, 'thread-ts');

    expect(result.action_status).toBe('waiting');
    expect(result.filed_to).toBeUndefined();
  });
});
