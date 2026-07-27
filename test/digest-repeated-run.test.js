import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import { runDigest } from '../pages/api/digest';
import { DIGEST_FIXTURE_EMAILS } from './fixtures/digest-emails';

// Full digest_runs de-duplication (one row per day, even across two runs) is
// a Phase 6 concurrency fix -- see test/future-phases.test.js. What's already
// true today, and worth locking in now, is that email_messages/memory_chunks
// writes go through upsert() with an onConflict key, which is what makes
// running the same fixture set twice safe at the row level.
describe('digest run idempotency (email_messages upsert wiring)', () => {
  it('upserts email_messages with onConflict=graph_message_id on every run, not a plain insert', async () => {
    const requests = [];
    server.use(
      http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:folder/messages', () =>
        HttpResponse.json({ value: DIGEST_FIXTURE_EMAILS.slice(0, 3) })
      ),
      http.post('https://test-project.supabase.co/rest/v1/email_messages', ({ request }) => {
        requests.push(new URL(request.url).search);
        return HttpResponse.json([{ id: 1 }]);
      })
    );

    await runDigest();
    await runDigest();

    expect(requests.length).toBeGreaterThan(0);
    for (const search of requests) {
      expect(search).toContain('on_conflict=graph_message_id');
    }
  });
});
