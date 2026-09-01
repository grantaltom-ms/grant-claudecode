// lib/calendar.js
// Microsoft Graph calendar helpers, built on lib/graph.js's request wrapper.
// Requires the Calendars.ReadWrite application permission (see
// docs/system-reference.md). Reads (listEvents, getAvailability) work with
// Calendars.Read alone; the mutating helpers (createEvent, updateEvent,
// cancelEvent) need the ReadWrite grant.
//
// Event creation/cancellation is never called directly from a Claude tool
// without an approval step -- see the calendar_event_drafts staging table
// and the propose_calendar_event / apply_calendar_event tools in
// pages/api/inbox-assistant.js, which mirror the create_draft_reply /
// send_draft pattern already used for email.

import { graph } from './graph';

const DEFAULT_TIME_ZONE = 'America/Los_Angeles';

function eventDateTime(dateTimeIso, timeZone = DEFAULT_TIME_ZONE) {
  return { dateTime: dateTimeIso, timeZone };
}

// Lists events between startIso and endIso (both full ISO 8601 instants) via
// Graph's calendarView, which -- unlike /events -- expands recurring
// meetings into individual occurrences within the window.
export async function listCalendarEvents(token, ownerEmail, startIso, endIso, { top = 25 } = {}) {
  const select = 'id,subject,start,end,location,organizer,attendees,isCancelled,isOnlineMeeting,onlineMeetingUrl,bodyPreview';
  const url = `/users/${ownerEmail}/calendarView`
    + `?startDateTime=${encodeURIComponent(startIso)}`
    + `&endDateTime=${encodeURIComponent(endIso)}`
    + `&$select=${select}`
    + `&$orderby=start/dateTime`
    + `&$top=${Math.min(top, 50)}`;
  const result = await graph(token, url);
  return result.value || [];
}

// Free/busy lookup via getSchedule, which returns an availabilityView string
// -- one digit per `intervalMinutes` slot across the window, 0=free,
// 1=tentative, 2=busy, 3=out-of-office, 4=working-elsewhere. Only the
// owner's own schedule is requested; getSchedule can take other attendees'
// addresses too but this app has no reason to query anyone else's calendar.
export async function getAvailability(token, ownerEmail, startIso, endIso, { intervalMinutes = 30 } = {}) {
  const result = await graph(token, `/users/${ownerEmail}/calendar/getSchedule`, 'POST', {
    schedules: [ownerEmail],
    startTime: eventDateTime(startIso),
    endTime: eventDateTime(endIso),
    availabilityViewInterval: intervalMinutes,
  });
  const schedule = result.value?.[0];
  return {
    availabilityView: schedule?.availabilityView || '',
    scheduleItems: schedule?.scheduleItems || [],
    intervalMinutes,
    error: schedule?.error || null,
  };
}

// Turns an availabilityView digit string into free slot windows, so callers
// don't have to decode Graph's compact format themselves.
export function freeSlotsFromAvailability(startIso, availabilityView, intervalMinutes) {
  const slots = [];
  let runStart = null;
  const start = new Date(startIso);

  for (let i = 0; i <= availabilityView.length; i++) {
    const isFree = i < availabilityView.length && availabilityView[i] === '0';
    if (isFree && runStart === null) {
      runStart = i;
    } else if (!isFree && runStart !== null) {
      const from = new Date(start.getTime() + runStart * intervalMinutes * 60_000);
      const to = new Date(start.getTime() + i * intervalMinutes * 60_000);
      slots.push({ start: from.toISOString(), end: to.toISOString() });
      runStart = null;
    }
  }
  return slots;
}

function buildEventPayload({ subject, startIso, endIso, timeZone, location, body, attendees, isOnlineMeeting }) {
  return {
    subject,
    start: eventDateTime(startIso, timeZone),
    end: eventDateTime(endIso, timeZone),
    ...(location && { location: { displayName: location } }),
    ...(body && { body: { contentType: 'Text', content: body } }),
    ...(attendees?.length && {
      attendees: attendees.map(address => ({
        emailAddress: { address },
        type: 'required',
      })),
    }),
    ...(isOnlineMeeting && { isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' }),
  };
}

// Creates the event via Graph. If attendees are present, Graph sends
// meeting invites immediately as part of this call -- there is no
// unsent-draft state on the Graph side, which is exactly why callers stage
// the event in calendar_event_drafts and only reach this after approval.
export async function createEvent(token, ownerEmail, fields) {
  return graph(token, `/users/${ownerEmail}/events`, 'POST', buildEventPayload(fields));
}

// PATCHing an event with attendees triggers Graph to send an update
// notification to them automatically -- same approval requirement as create.
export async function updateEvent(token, ownerEmail, eventId, fields) {
  const payload = {};
  if (fields.subject !== undefined) payload.subject = fields.subject;
  if (fields.startIso !== undefined) payload.start = eventDateTime(fields.startIso, fields.timeZone);
  if (fields.endIso !== undefined) payload.end = eventDateTime(fields.endIso, fields.timeZone);
  if (fields.location !== undefined) payload.location = { displayName: fields.location };
  if (fields.body !== undefined) payload.body = { contentType: 'Text', content: fields.body };
  if (fields.attendees !== undefined) {
    payload.attendees = fields.attendees.map(address => ({ emailAddress: { address }, type: 'required' }));
  }
  return graph(token, `/users/${ownerEmail}/events/${eventId}`, 'PATCH', payload);
}

// Uses the /cancel action (rather than DELETE) so a human-readable comment
// can be sent to attendees along with the cancellation notice.
export async function cancelEvent(token, ownerEmail, eventId, comment = '') {
  return graph(token, `/users/${ownerEmail}/events/${eventId}/cancel`, 'POST', { comment });
}

export async function getEvent(token, ownerEmail, eventId) {
  const select = 'id,subject,start,end,location,organizer,attendees,isCancelled,bodyPreview';
  return graph(token, `/users/${ownerEmail}/events/${eventId}?$select=${select}`);
}
