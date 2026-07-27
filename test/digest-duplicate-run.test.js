import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import { runDigest } from '../pages/api/digest';
import { DIGEST_FIXTURE_EMAILS } from './fixtures/digest-emails';

describe('digest run duplicate-trigger protection', () => {
  it('skips entirely (no Graph call, no Slack post) when a digest_runs row is already in-flight', async () => {
    let graphCalls = 0;
    let slackPosts = 0;

    server.use(
      // GET on digest_runs (the in-flight check) returns one still-`started` row.
      http.get('https://test-project.supabase.co/rest/v1/digest_runs', () =>
        HttpResponse.json([{ id: 'existing-run-id', run_started_at: new Date().toISOString() }])
      ),
      http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:folder/messages', () => {
        graphCalls += 1;
        return HttpResponse.json({ value: DIGEST_FIXTURE_EMAILS });
      }),
      http.post('https://slack.com/api/chat.postMessage', () => {
        slackPosts += 1;
        return HttpResponse.json({ ok: true, ts: '1700000000.000001' });
      })
    );

    await runDigest();

    expect(graphCalls).toBe(0);
    expect(slackPosts).toBe(0);
  });

  it('proceeds normally when no in-flight run exists', async () => {
    let graphCalls = 0;
    const posts = [];

    server.use(
      http.get('https://test-project.supabase.co/rest/v1/digest_runs', () => HttpResponse.json([])),
      http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:folder/messages', () => {
        graphCalls += 1;
        return HttpResponse.json({ value: DIGEST_FIXTURE_EMAILS.slice(0, 2) });
      }),
      http.post('https://slack.com/api/chat.postMessage', async ({ request }) => {
        const body = await request.json();
        posts.push(body.text);
        return HttpResponse.json({ ok: true, ts: `${1700000000 + posts.length}.000001` });
      })
    );

    await runDigest();

    expect(graphCalls).toBe(1);
    expect(posts.length).toBeGreaterThan(0);
  });
});
