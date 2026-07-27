import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { claimSlackEvent } from '../../lib/event-dedup';

describe('claimSlackEvent', () => {
  it('claims a new event_id (first delivery)', async () => {
    server.use(
      http.post('https://test-project.supabase.co/rest/v1/processed_slack_events', () =>
        HttpResponse.json([{ event_id: 'Ev123' }], { status: 201 })
      )
    );

    expect(await claimSlackEvent('Ev123')).toBe(true);
  });

  it('rejects a duplicate delivery of the same event_id', async () => {
    server.use(
      http.post('https://test-project.supabase.co/rest/v1/processed_slack_events', () =>
        HttpResponse.json(
          { code: '23505', message: 'duplicate key value violates unique constraint' },
          { status: 409 }
        )
      )
    );

    expect(await claimSlackEvent('Ev123')).toBe(false);
  });

  it('fails open (processes the event) if the dedup table itself errors', async () => {
    server.use(
      http.post('https://test-project.supabase.co/rest/v1/processed_slack_events', () =>
        HttpResponse.json({ code: '42P01', message: 'relation does not exist' }, { status: 404 })
      )
    );

    expect(await claimSlackEvent('Ev123')).toBe(true);
  });

  it('returns true with no network call when there is no event_id to dedup on', async () => {
    // No handler registered for this test -- onUnhandledRequest:'error' would
    // fail the test if claimSlackEvent tried to hit the network anyway.
    expect(await claimSlackEvent(undefined)).toBe(true);
  });
});
