import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { supabase } from '../../lib/supabase';
import {
  normalizeEmail,
  isExternalContact,
  loadContactHistory,
  buildContactStats,
  loadCorrespondentStatsMap,
} from '../../lib/correspondent-history';

const OWNER_EMAIL = 'grant@milestoneproperties.net';

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Foo@BAR.com ')).toBe('foo@bar.com');
  });

  it('handles null/undefined', () => {
    expect(normalizeEmail(undefined)).toBe('');
    expect(normalizeEmail(null)).toBe('');
  });
});

describe('isExternalContact', () => {
  it('excludes the owner address itself', () => {
    expect(isExternalContact(OWNER_EMAIL, OWNER_EMAIL)).toBe(false);
  });

  it("excludes addresses on the owner's domain", () => {
    expect(isExternalContact('kelsey@milestoneproperties.net', OWNER_EMAIL)).toBe(false);
  });

  it("includes addresses outside the owner's domain", () => {
    expect(isExternalContact('crystal.li@becu.org', OWNER_EMAIL)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isExternalContact('Crystal.Li@BECU.org', OWNER_EMAIL)).toBe(true);
  });

  it('returns false for an empty address', () => {
    expect(isExternalContact('', OWNER_EMAIL)).toBe(false);
  });
});

function message(overrides) {
  return {
    id: overrides.id,
    graph_message_id: overrides.id,
    graph_conversation_id: overrides.conversationId,
    folder: overrides.folder,
    subject: overrides.subject,
    sender_email: overrides.senderEmail,
    recipients: overrides.recipients || [],
    cc_recipients: overrides.ccRecipients || [],
    received_at: overrides.receivedAt || null,
    sent_at: overrides.sentAt || null,
  };
}

describe('buildContactStats', () => {
  it('counts inbound Inbox mail from an external sender and tracks last subject/timestamp', () => {
    const messages = [
      message({ id: 'm1', conversationId: 'c1', folder: 'Inbox', subject: 'Hi', senderEmail: 'crystal.li@becu.org', receivedAt: '2026-01-01T00:00:00Z' }),
    ];
    const stats = buildContactStats(messages, OWNER_EMAIL);
    const contact = stats.get('crystal.li@becu.org');
    expect(contact.inbound_count).toBe(1);
    expect(contact.outbound_count).toBe(0);
    expect(contact.last_subject).toBe('Hi');
    expect(contact.last_message_at).toBe('2026-01-01T00:00:00Z');
  });

  it('counts outbound SentItems mail to each external recipient', () => {
    const messages = [
      message({
        id: 'm2', conversationId: 'c1', folder: 'SentItems', subject: 'Re: Hi',
        senderEmail: OWNER_EMAIL,
        recipients: [{ emailAddress: { address: 'crystal.li@becu.org' } }],
        sentAt: '2026-01-02T00:00:00Z',
      }),
    ];
    const stats = buildContactStats(messages, OWNER_EMAIL);
    const contact = stats.get('crystal.li@becu.org');
    expect(contact.outbound_count).toBe(1);
    expect(contact.inbound_count).toBe(0);
  });

  it('excludes internal addresses from stats entirely', () => {
    const messages = [
      message({ id: 'm3', conversationId: 'c2', folder: 'Inbox', subject: 'Internal', senderEmail: 'kelsey@milestoneproperties.net', receivedAt: '2026-01-01T00:00:00Z' }),
    ];
    const stats = buildContactStats(messages, OWNER_EMAIL);
    expect(stats.has('kelsey@milestoneproperties.net')).toBe(false);
  });

  it('computes back_and_forth_thread_count only when a conversation has both directions', () => {
    const messages = [
      message({ id: 'm4', conversationId: 'c3', folder: 'Inbox', subject: 'Q', senderEmail: 'vendor@example.com', receivedAt: '2026-01-01T00:00:00Z' }),
      message({
        id: 'm5', conversationId: 'c3', folder: 'SentItems', subject: 'Re: Q', senderEmail: OWNER_EMAIL,
        recipients: [{ emailAddress: { address: 'vendor@example.com' } }], sentAt: '2026-01-02T00:00:00Z',
      }),
    ];
    const stats = buildContactStats(messages, OWNER_EMAIL);
    expect(stats.get('vendor@example.com').back_and_forth_thread_count).toBe(1);
  });

  it('does not count an inbound-only sender as back-and-forth', () => {
    const messages = [
      message({ id: 'm6', conversationId: 'c5', folder: 'Inbox', subject: 'Notice 1', senderEmail: 'notifications@docusign.net', receivedAt: '2026-01-01T00:00:00Z' }),
      message({ id: 'm7', conversationId: 'c6', folder: 'Inbox', subject: 'Notice 2', senderEmail: 'notifications@docusign.net', receivedAt: '2026-01-02T00:00:00Z' }),
      message({ id: 'm8', conversationId: 'c7', folder: 'Inbox', subject: 'Notice 3', senderEmail: 'notifications@docusign.net', receivedAt: '2026-01-03T00:00:00Z' }),
    ];
    const stats = buildContactStats(messages, OWNER_EMAIL);
    const contact = stats.get('notifications@docusign.net');
    expect(contact.inbound_count).toBe(3);
    expect(contact.outbound_count).toBe(0);
    expect(contact.back_and_forth_thread_count).toBe(0);
  });

  it('tracks the most recent subject/timestamp across both directions', () => {
    const messages = [
      message({ id: 'm9', conversationId: 'c4', folder: 'Inbox', subject: 'Older', senderEmail: 'vendor@example.com', receivedAt: '2026-01-01T00:00:00Z' }),
      message({
        id: 'm10', conversationId: 'c4', folder: 'SentItems', subject: 'Newer', senderEmail: OWNER_EMAIL,
        recipients: [{ emailAddress: { address: 'vendor@example.com' } }], sentAt: '2026-01-05T00:00:00Z',
      }),
    ];
    const stats = buildContactStats(messages, OWNER_EMAIL);
    const contact = stats.get('vendor@example.com');
    expect(contact.last_subject).toBe('Newer');
    expect(contact.last_message_at).toBe('2026-01-05T00:00:00Z');
  });
});

describe('loadContactHistory / loadCorrespondentStatsMap', () => {
  it('queries email_messages and returns a usable stats map', async () => {
    server.use(
      http.get('https://test-project.supabase.co/rest/v1/email_messages', () =>
        HttpResponse.json([
          message({ id: 'm1', conversationId: 'c1', folder: 'Inbox', subject: 'Hi', senderEmail: 'crystal.li@becu.org', receivedAt: '2026-01-01T00:00:00Z' }),
        ])
      )
    );
    const stats = await loadCorrespondentStatsMap(supabase, OWNER_EMAIL, { days: 90, maxMessages: 500 });
    expect(stats.get('crystal.li@becu.org').inbound_count).toBe(1);
  });

  it('throws a descriptive error when the query fails', async () => {
    server.use(
      http.get('https://test-project.supabase.co/rest/v1/email_messages', () =>
        HttpResponse.json({ message: 'boom' }, { status: 500 })
      )
    );
    await expect(loadContactHistory(supabase, OWNER_EMAIL, {})).rejects.toThrow(/Contact history load failed/);
  });

  it('returns an empty array/map when there is no history', async () => {
    server.use(
      http.get('https://test-project.supabase.co/rest/v1/email_messages', () => HttpResponse.json([]))
    );
    const stats = await loadCorrespondentStatsMap(supabase, OWNER_EMAIL, {});
    expect(stats.size).toBe(0);
  });
});
