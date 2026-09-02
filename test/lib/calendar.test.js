import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { getGraphToken } from '../../lib/graph';
import {
  listCalendarEvents,
  getAvailability,
  freeSlotsFromAvailability,
  createEvent,
  updateEvent,
  cancelEvent,
} from '../../lib/calendar';

const OWNER = 'grant@milestoneproperties.net';

describe('listCalendarEvents', () => {
  it('queries calendarView with the given window and returns value', async () => {
    let requestUrl;
    server.use(
      http.get('https://graph.microsoft.com/v1.0/users/:email/calendarView', ({ request }) => {
        requestUrl = new URL(request.url);
        return HttpResponse.json({ value: [{ id: 'evt-1', subject: 'Lender call' }] });
      })
    );

    const token = await getGraphToken();
    const events = await listCalendarEvents(token, OWNER, '2026-09-01T00:00:00Z', '2026-09-08T00:00:00Z');

    expect(events).toEqual([{ id: 'evt-1', subject: 'Lender call' }]);
    expect(requestUrl.searchParams.get('startDateTime')).toBe('2026-09-01T00:00:00Z');
    expect(requestUrl.searchParams.get('endDateTime')).toBe('2026-09-08T00:00:00Z');
  });
});

describe('getAvailability', () => {
  it('posts getSchedule and returns the owner schedule', async () => {
    let requestBody;
    server.use(
      http.post('https://graph.microsoft.com/v1.0/users/:email/calendar/getSchedule', async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({ value: [{ availabilityView: '0220', scheduleItems: [] }] });
      })
    );

    const token = await getGraphToken();
    const result = await getAvailability(token, OWNER, '2026-09-01T09:00:00Z', '2026-09-01T11:00:00Z', { intervalMinutes: 30 });

    expect(requestBody.schedules).toEqual([OWNER]);
    expect(requestBody.availabilityViewInterval).toBe(30);
    expect(result.availabilityView).toBe('0220');
    expect(result.intervalMinutes).toBe(30);
  });
});

describe('freeSlotsFromAvailability', () => {
  it('turns a digit string into free time windows', () => {
    // 30-min slots starting 09:00: free, busy, busy, free
    const slots = freeSlotsFromAvailability('2026-09-01T09:00:00.000Z', '0220', 30);
    expect(slots).toEqual([
      { start: '2026-09-01T09:00:00.000Z', end: '2026-09-01T09:30:00.000Z' },
      { start: '2026-09-01T10:30:00.000Z', end: '2026-09-01T11:00:00.000Z' },
    ]);
  });

  it('returns no slots when every interval is busy', () => {
    expect(freeSlotsFromAvailability('2026-09-01T09:00:00.000Z', '2222', 30)).toEqual([]);
  });

  it('treats a fully free window as one slot', () => {
    const slots = freeSlotsFromAvailability('2026-09-01T09:00:00.000Z', '0000', 30);
    expect(slots).toEqual([{ start: '2026-09-01T09:00:00.000Z', end: '2026-09-01T11:00:00.000Z' }]);
  });
});

describe('createEvent', () => {
  it('sends attendees as required participants and returns the created event', async () => {
    let requestBody;
    server.use(
      http.post('https://graph.microsoft.com/v1.0/users/:email/events', async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({ id: 'evt-new', subject: requestBody.subject });
      })
    );

    const token = await getGraphToken();
    const result = await createEvent(token, OWNER, {
      subject: 'Insurance renewal call',
      startIso: '2026-09-05T14:00:00',
      endIso: '2026-09-05T14:30:00',
      attendees: ['crystal.li@becu.org'],
    });

    expect(result.id).toBe('evt-new');
    expect(requestBody.start).toEqual({ dateTime: '2026-09-05T14:00:00', timeZone: 'America/Los_Angeles' });
    expect(requestBody.attendees).toEqual([{ emailAddress: { address: 'crystal.li@becu.org' }, type: 'required' }]);
  });

  it('omits attendees entirely when none are given', async () => {
    let requestBody;
    server.use(
      http.post('https://graph.microsoft.com/v1.0/users/:email/events', async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({ id: 'evt-solo' });
      })
    );

    const token = await getGraphToken();
    await createEvent(token, OWNER, {
      subject: 'Block time',
      startIso: '2026-09-05T14:00:00',
      endIso: '2026-09-05T15:00:00',
      attendees: [],
    });

    expect(requestBody.attendees).toBeUndefined();
  });
});

describe('updateEvent', () => {
  it('only patches fields that were actually provided', async () => {
    let requestBody;
    server.use(
      http.patch('https://graph.microsoft.com/v1.0/users/:email/events/:id', async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({ id: 'evt-1' });
      })
    );

    const token = await getGraphToken();
    await updateEvent(token, OWNER, 'evt-1', { subject: 'Moved: Lender call' });

    expect(requestBody).toEqual({ subject: 'Moved: Lender call' });
  });
});

describe('cancelEvent', () => {
  it('posts to the /cancel action with a comment', async () => {
    let requestBody;
    server.use(
      http.post('https://graph.microsoft.com/v1.0/users/:email/events/:id/cancel', async ({ request }) => {
        requestBody = await request.json();
        return new HttpResponse(null, { status: 202 });
      })
    );

    const token = await getGraphToken();
    const result = await cancelEvent(token, OWNER, 'evt-1', 'No longer needed.');

    expect(requestBody).toEqual({ comment: 'No longer needed.' });
    expect(result.success).toBe(true);
  });
});
