import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { supabase } from '../../lib/supabase';
import { upsertThreadMemory } from '../../lib/email-thread-memory';

const OWNER_EMAIL = 'grant@milestoneproperties.net';

function inboundEmail(overrides = {}) {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    subject: 'Hello',
    from: { emailAddress: { name: 'Vendor', address: 'vendor@example.com' } },
    toRecipients: [{ emailAddress: { name: 'Grant Carlson', address: OWNER_EMAIL } }],
    ccRecipients: [],
    receivedDateTime: '2026-01-01T00:00:00Z',
    sentDateTime: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function sentEmail(overrides = {}) {
  return {
    id: 'msg-2',
    conversationId: 'conv-1',
    subject: 'Re: Hello',
    from: { emailAddress: { name: 'Grant Carlson', address: OWNER_EMAIL } },
    toRecipients: [{ emailAddress: { name: 'Vendor', address: 'vendor@example.com' } }],
    ccRecipients: [],
    receivedDateTime: '2026-01-02T00:00:00Z',
    sentDateTime: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

describe('upsertThreadMemory', () => {
  it('returns null and does nothing without a conversationId', async () => {
    const result = await upsertThreadMemory(supabase, OWNER_EMAIL, { ...inboundEmail(), conversationId: undefined });
    expect(result).toBeNull();
  });

  it('creates a new thread record with participants from an inbound email', async () => {
    let upserted;
    server.use(
      http.get('https://test-project.supabase.co/rest/v1/email_threads', () => HttpResponse.json([])),
      http.get('https://test-project.supabase.co/rest/v1/email_messages', () => HttpResponse.json([{ id: 'x' }])),
      http.post('https://test-project.supabase.co/rest/v1/email_threads', async ({ request }) => {
        upserted = await request.json();
        return HttpResponse.json([{ ...upserted, id: 'thread-1' }]);
      })
    );

    const result = await upsertThreadMemory(supabase, OWNER_EMAIL, inboundEmail());

    expect(upserted.owner_email).toBe(OWNER_EMAIL);
    expect(upserted.participant_emails).toEqual(expect.arrayContaining(['vendor@example.com', OWNER_EMAIL]));
    expect(result).toBeTruthy();
  });

  it("folds a sent-shaped email's recipients into participant_emails the same way as an inbound one", async () => {
    let upserted;
    server.use(
      http.get('https://test-project.supabase.co/rest/v1/email_threads', () => HttpResponse.json([])),
      http.get('https://test-project.supabase.co/rest/v1/email_messages', () => HttpResponse.json([{ id: 'x' }])),
      http.post('https://test-project.supabase.co/rest/v1/email_threads', async ({ request }) => {
        upserted = await request.json();
        return HttpResponse.json([{ ...upserted, id: 'thread-1' }]);
      })
    );

    await upsertThreadMemory(supabase, OWNER_EMAIL, sentEmail());

    expect(upserted.participant_emails).toEqual(expect.arrayContaining(['vendor@example.com', OWNER_EMAIL]));
  });

  it('merges participants and extends last_message_at/first_message_at across repeated calls', async () => {
    let existingRow = null;
    server.use(
      http.get('https://test-project.supabase.co/rest/v1/email_threads', () => HttpResponse.json(existingRow ? [existingRow] : [])),
      http.get('https://test-project.supabase.co/rest/v1/email_messages', () => HttpResponse.json([{ id: 'x' }, { id: 'y' }])),
      http.post('https://test-project.supabase.co/rest/v1/email_threads', async ({ request }) => {
        const body = await request.json();
        existingRow = body;
        return HttpResponse.json([{ ...body, id: 'thread-1' }]);
      })
    );

    await upsertThreadMemory(supabase, OWNER_EMAIL, inboundEmail());
    await upsertThreadMemory(supabase, OWNER_EMAIL, sentEmail());

    expect(existingRow.last_message_at).toBe('2026-01-02T00:00:00Z');
    expect(existingRow.first_message_at).toBe('2026-01-01T00:00:00Z');
    expect(existingRow.participant_emails.length).toBeGreaterThanOrEqual(2);
  });

  it('calls onError with the load_thread stage when the thread lookup fails, without throwing', async () => {
    server.use(
      http.get('https://test-project.supabase.co/rest/v1/email_threads', () => HttpResponse.json({ message: 'boom' }, { status: 500 }))
    );

    const stages = [];
    const result = await upsertThreadMemory(supabase, OWNER_EMAIL, inboundEmail(), {
      onError: (stage) => stages.push(stage),
    });

    expect(result).toBeNull();
    expect(stages).toEqual(['load_thread']);
  });
});
