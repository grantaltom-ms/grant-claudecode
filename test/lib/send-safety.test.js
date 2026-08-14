import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { supabase } from '../../lib/supabase';
import { checkSendRateLimit, recordSend, flagNewRecipients } from '../../lib/send-safety';

const OWNER_EMAIL = 'grant@milestoneproperties.net';

describe('checkSendRateLimit', () => {
  const originalLimit = process.env.MAX_SENDS_PER_DAY;

  afterEach(() => {
    if (originalLimit === undefined) delete process.env.MAX_SENDS_PER_DAY;
    else process.env.MAX_SENDS_PER_DAY = originalLimit;
  });

  it('allows a send when under the default limit', async () => {
    delete process.env.MAX_SENDS_PER_DAY;
    // The default mock returns [] with no content-range header, so
    // supabase-js resolves count to null -- checkSendRateLimit treats that
    // as 0 sent so far, which is under any positive limit.
    const result = await checkSendRateLimit(supabase, OWNER_EMAIL);
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(25);
  });

  it('blocks once the configured limit is reached', async () => {
    process.env.MAX_SENDS_PER_DAY = '0';
    const result = await checkSendRateLimit(supabase, OWNER_EMAIL);
    expect(result.allowed).toBe(false);
    expect(result.limit).toBe(0);
  });

  it('fails open (allowed: true) if the rate-limit query errors, but surfaces the error', async () => {
    server.use(
      http.head('https://test-project.supabase.co/rest/v1/send_log', () =>
        HttpResponse.json({ message: 'relation "send_log" does not exist', code: '42P01' }, { status: 500 })
      )
    );
    const result = await checkSendRateLimit(supabase, OWNER_EMAIL);
    expect(result.allowed).toBe(true);
    expect(result.error).toBeTruthy();
  });
});

describe('recordSend', () => {
  it('inserts one send_log row per recipient with the message id', async () => {
    let insertedBody;
    server.use(
      http.post('https://test-project.supabase.co/rest/v1/send_log', async ({ request }) => {
        insertedBody = await request.json();
        return HttpResponse.json([]);
      })
    );

    await recordSend(supabase, OWNER_EMAIL, ['a@example.com', 'b@example.com'], 'draft-123');

    expect(insertedBody).toEqual([
      { owner_email: OWNER_EMAIL, recipient: 'a@example.com', message_id: 'draft-123' },
      { owner_email: OWNER_EMAIL, recipient: 'b@example.com', message_id: 'draft-123' },
    ]);
  });

  it('is a no-op with no recipients', async () => {
    let called = false;
    server.use(
      http.post('https://test-project.supabase.co/rest/v1/send_log', () => {
        called = true;
        return HttpResponse.json([]);
      })
    );

    await recordSend(supabase, OWNER_EMAIL, [], 'draft-123');
    expect(called).toBe(false);
  });
});

describe('flagNewRecipients', () => {
  const originalTrusted = process.env.TRUSTED_DOMAINS;

  beforeEach(() => {
    delete process.env.TRUSTED_DOMAINS;
  });

  afterEach(() => {
    if (originalTrusted === undefined) delete process.env.TRUSTED_DOMAINS;
    else process.env.TRUSTED_DOMAINS = originalTrusted;
  });

  it('never flags an address on the default trusted domain, without even querying', async () => {
    let queried = false;
    server.use(
      http.get('https://test-project.supabase.co/rest/v1/email_messages', () => {
        queried = true;
        return HttpResponse.json([]);
      })
    );

    const flagged = await flagNewRecipients(supabase, OWNER_EMAIL, ['kelsey@milestoneproperties.net']);
    expect(flagged).toEqual([]);
    expect(queried).toBe(false);
  });

  it('flags an address with no prior correspondence in email_messages', async () => {
    server.use(
      http.get('https://test-project.supabase.co/rest/v1/email_messages', () => HttpResponse.json([]))
    );

    const flagged = await flagNewRecipients(supabase, OWNER_EMAIL, ['newvendor@example.com']);
    expect(flagged).toEqual(['newvendor@example.com']);
  });

  it('does not flag an address found in prior email_messages history', async () => {
    server.use(
      http.get('https://test-project.supabase.co/rest/v1/email_messages', () =>
        HttpResponse.json([{ id: 'msg-1' }])
      )
    );

    const flagged = await flagNewRecipients(supabase, OWNER_EMAIL, ['knownvendor@example.com']);
    expect(flagged).toEqual([]);
  });

  it('respects a custom TRUSTED_DOMAINS list', async () => {
    process.env.TRUSTED_DOMAINS = 'becu.org, escrow.com';
    server.use(
      http.get('https://test-project.supabase.co/rest/v1/email_messages', () => HttpResponse.json([]))
    );

    const flagged = await flagNewRecipients(supabase, OWNER_EMAIL, ['crystal.li@becu.org', 'newvendor@example.com']);
    expect(flagged).toEqual(['newvendor@example.com']);
  });

  it('dedupes case-insensitively', async () => {
    server.use(
      http.get('https://test-project.supabase.co/rest/v1/email_messages', () => HttpResponse.json([]))
    );

    const flagged = await flagNewRecipients(supabase, OWNER_EMAIL, ['New@Example.com', 'new@example.com']);
    expect(flagged).toEqual(['new@example.com']);
  });
});
