import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import { executeTool } from '../pages/api/inbox-assistant';

const TOKEN = 'test-graph-token';

describe('inbox-assistant calendar approval flow', () => {
  it('propose_calendar_event stages a draft without touching the calendar', async () => {
    let insertedBody;
    let eventsCalled = false;
    server.use(
      http.post('https://test-project.supabase.co/rest/v1/calendar_event_drafts', async ({ request }) => {
        insertedBody = await request.json();
        // supabase-js's .maybeSingle() on a non-GET request sends
        // Accept: application/vnd.pgrst.object+json and parses the body as
        // a single object, not an array -- unlike GET, it does not unwrap
        // a `[...]` response (see postgrest-js's PostgrestBuilder.js).
        return HttpResponse.json({ id: 'draft-1', ...insertedBody });
      }),
      http.post('https://graph.microsoft.com/v1.0/users/:email/events', () => {
        eventsCalled = true;
        return HttpResponse.json({ id: 'should-not-be-created' });
      })
    );

    const result = await executeTool('propose_calendar_event', {
      subject: 'Insurance renewal call',
      start_time: '2026-09-05T14:00:00',
      end_time: '2026-09-05T14:30:00',
      attendees: ['crystal.li@becu.org'],
    }, TOKEN, 'thread-ts');

    expect(result.draft.id).toBe('draft-1');
    expect(result.message).toMatch(/Awaiting approval/);
    expect(insertedBody.action).toBe('create');
    expect(insertedBody.status).toBe('pending');
    expect(eventsCalled).toBe(false);
  });

  it('rejects a new-event proposal missing required fields', async () => {
    await expect(
      executeTool('propose_calendar_event', { subject: 'No times' }, TOKEN, 'thread-ts')
    ).rejects.toThrow(/subject, start_time, and end_time/);
  });

  it('rejects an update/cancel proposal without event_id', async () => {
    await expect(
      executeTool('propose_calendar_event', { action: 'cancel' }, TOKEN, 'thread-ts')
    ).rejects.toThrow(/event_id is required/);
  });

  it('apply_calendar_event creates the real event and sends invites only after approval', async () => {
    const draft = {
      id: 'draft-2',
      owner_email: 'grant@milestoneproperties.net',
      action: 'create',
      target_event_id: null,
      subject: 'Insurance renewal call',
      start_time: '2026-09-05T14:00:00',
      end_time: '2026-09-05T14:30:00',
      time_zone: 'America/Los_Angeles',
      location: null,
      body: null,
      attendees: ['crystal.li@becu.org'],
      cancel_comment: null,
      status: 'pending',
    };
    let createdEventBody;
    let updatedDraftBody;
    server.use(
      http.get('https://test-project.supabase.co/rest/v1/calendar_event_drafts', () => HttpResponse.json([draft])),
      http.patch('https://test-project.supabase.co/rest/v1/calendar_event_drafts', async ({ request }) => {
        updatedDraftBody = await request.json();
        return HttpResponse.json([]);
      }),
      http.post('https://graph.microsoft.com/v1.0/users/:email/events', async ({ request }) => {
        createdEventBody = await request.json();
        return HttpResponse.json({ id: 'evt-real' });
      })
    );

    const result = await executeTool('apply_calendar_event', { draft_id: 'draft-2' }, TOKEN, 'thread-ts');

    expect(result.success).toBe(true);
    expect(result.graph_event_id).toBe('evt-real');
    expect(createdEventBody.attendees).toEqual([{ emailAddress: { address: 'crystal.li@becu.org' }, type: 'required' }]);
    expect(updatedDraftBody.status).toBe('sent');
    expect(updatedDraftBody.graph_event_id).toBe('evt-real');
  });

  it('apply_calendar_event cancels an existing event via the /cancel action', async () => {
    const draft = {
      id: 'draft-3',
      action: 'cancel',
      target_event_id: 'evt-existing',
      cancel_comment: 'Rescheduling, will resend.',
      status: 'pending',
      attendees: [],
    };
    let cancelBody;
    server.use(
      http.get('https://test-project.supabase.co/rest/v1/calendar_event_drafts', () => HttpResponse.json([draft])),
      http.patch('https://test-project.supabase.co/rest/v1/calendar_event_drafts', () => HttpResponse.json([])),
      http.post('https://graph.microsoft.com/v1.0/users/:email/events/:id/cancel', async ({ request }) => {
        cancelBody = await request.json();
        return new HttpResponse(null, { status: 202 });
      })
    );

    const result = await executeTool('apply_calendar_event', { draft_id: 'draft-3' }, TOKEN, 'thread-ts');

    expect(result.success).toBe(true);
    expect(result.action).toBe('cancel');
    expect(cancelBody).toEqual({ comment: 'Rescheduling, will resend.' });
  });

  it('apply_calendar_event refuses to re-apply an already-applied draft', async () => {
    server.use(
      http.get('https://test-project.supabase.co/rest/v1/calendar_event_drafts', () =>
        HttpResponse.json([{ id: 'draft-4', status: 'sent' }])
      )
    );

    const result = await executeTool('apply_calendar_event', { draft_id: 'draft-4' }, TOKEN, 'thread-ts');
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/already sent/);
  });

  it('discard_calendar_event marks the draft discarded without calling Graph', async () => {
    let discardBody;
    let eventsCalled = false;
    server.use(
      http.patch('https://test-project.supabase.co/rest/v1/calendar_event_drafts', async ({ request }) => {
        discardBody = await request.json();
        return HttpResponse.json({ id: 'draft-5', status: 'discarded' });
      }),
      http.post('https://graph.microsoft.com/v1.0/users/:email/events', () => {
        eventsCalled = true;
        return HttpResponse.json({});
      })
    );

    const result = await executeTool('discard_calendar_event', { draft_id: 'draft-5' }, TOKEN, 'thread-ts');
    expect(result.success).toBe(true);
    expect(result.draft.status).toBe('discarded');
    expect(discardBody.status).toBe('discarded');
    expect(eventsCalled).toBe(false);
  });

  it('find_availability returns free slots derived from getSchedule', async () => {
    server.use(
      http.post('https://graph.microsoft.com/v1.0/users/:email/calendar/getSchedule', () =>
        HttpResponse.json({ value: [{ availabilityView: '0220' }] })
      )
    );

    const result = await executeTool('find_availability', {
      start_date: '2026-09-01T09:00:00.000Z',
      end_date: '2026-09-01T11:00:00.000Z',
      interval_minutes: 30,
    }, TOKEN, 'thread-ts');

    expect(result.free_slots).toEqual([
      { start: '2026-09-01T09:00:00.000Z', end: '2026-09-01T09:30:00.000Z' },
      { start: '2026-09-01T10:30:00.000Z', end: '2026-09-01T11:00:00.000Z' },
    ]);
  });
});
