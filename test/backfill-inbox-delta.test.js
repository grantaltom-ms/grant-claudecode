import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import { runInboxDeltaBackfill } from '../pages/api/backfill-inbox-delta';

const OWNER_EMAIL = 'grant@milestoneproperties.net';

function deltaStateHandler(row) {
  return http.get('https://test-project.supabase.co/rest/v1/inbox_delta_state', () =>
    HttpResponse.json(row ? [row] : [])
  );
}

describe('runInboxDeltaBackfill', () => {
  it('reports already_bootstrapped and does nothing when a cursor is already established', async () => {
    server.use(
      deltaStateHandler({ owner_email: OWNER_EMAIL, cursor_url: 'https://graph.microsoft.com/v1.0/some-delta-link', is_bootstrapped: true })
    );

    const { status, body } = await runInboxDeltaBackfill();

    expect(status).toBe(200);
    expect(body.already_bootstrapped).toBe(true);
  });

  it('walks up to maxPages on a fresh start and persists a resumable cursor when not yet done', async () => {
    let upserted;
    server.use(
      deltaStateHandler(null),
      http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:folder/messages/delta', () =>
        HttpResponse.json({ value: [{ id: 'a' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/resume-1' })
      ),
      http.get('https://graph.microsoft.com/v1.0/resume-1', () =>
        HttpResponse.json({ value: [{ id: 'b' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/resume-1' })
      ),
      http.post('https://test-project.supabase.co/rest/v1/inbox_delta_state', async ({ request }) => {
        upserted = await request.json();
        return HttpResponse.json([]);
      })
    );

    const { status, body } = await runInboxDeltaBackfill({ maxPages: 2 });

    expect(status).toBe(200);
    expect(body.bootstrap_complete).toBe(false);
    expect(body.pages_walked_this_call).toBe(2);
    expect(upserted.cursor_url).toBe('https://graph.microsoft.com/v1.0/resume-1');
    expect(upserted.is_bootstrapped).toBe(false);
  });

  it('resumes from a stored cursor_url and completes bootstrap once Graph returns a deltaLink', async () => {
    let upserted;
    server.use(
      deltaStateHandler({ owner_email: OWNER_EMAIL, cursor_url: 'https://graph.microsoft.com/v1.0/resume-2', is_bootstrapped: false }),
      http.get('https://graph.microsoft.com/v1.0/resume-2', () =>
        HttpResponse.json({ value: [{ id: 'last-page' }], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/final-delta-link' })
      ),
      http.post('https://test-project.supabase.co/rest/v1/inbox_delta_state', async ({ request }) => {
        upserted = await request.json();
        return HttpResponse.json([]);
      })
    );

    const { status, body } = await runInboxDeltaBackfill({ maxPages: 20 });

    expect(status).toBe(200);
    expect(body.bootstrap_complete).toBe(true);
    expect(upserted.cursor_url).toBe('https://graph.microsoft.com/v1.0/final-delta-link');
    expect(upserted.is_bootstrapped).toBe(true);
  });
});
