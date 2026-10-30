import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { slackPost, slackUpdateMessage, getThreadHistory } from '../../lib/slack';

// Retry-After: 0 keeps these fast; the waiting itself is covered in retry.test.js.
const rateLimited = () => new HttpResponse(JSON.stringify({ ok: false, error: 'ratelimited' }), { status: 429, headers: { 'retry-after': '0' } });

describe('Slack calls retry only when it is safe', () => {
  let warn;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('a post that Slack rate-limits is sent again and lands once', async () => {
    let calls = 0;
    server.use(
      http.post('https://slack.com/api/chat.postMessage', () => {
        calls += 1;
        return calls === 1 ? rateLimited() : HttpResponse.json({ ok: true, ts: '1.2' });
      })
    );
    await expect(slackPost('t', 'C1', 'hello')).resolves.toMatchObject({ ok: true });
    expect(calls).toBe(2);
    expect(warn).toHaveBeenCalled();
  });

  it('"ratelimited" in a 200 response is treated the same way', async () => {
    let calls = 0;
    server.use(
      http.post('https://slack.com/api/chat.postMessage', () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ ok: false, error: 'ratelimited' }, { headers: { 'retry-after': '0' } })
          : HttpResponse.json({ ok: true });
      })
    );
    await slackPost('t', 'C1', 'hello');
    expect(calls).toBe(2);
  });

  it('a post that fails with a dropped connection is NOT resent (it may already be in the channel)', async () => {
    let calls = 0;
    server.use(
      http.post('https://slack.com/api/chat.postMessage', () => {
        calls += 1;
        return HttpResponse.error();
      })
    );
    await expect(slackPost('t', 'C1', 'hello')).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('a real Slack error (e.g. channel_not_found) fails at once with the same message as before', async () => {
    let calls = 0;
    server.use(
      http.post('https://slack.com/api/chat.postMessage', () => {
        calls += 1;
        return HttpResponse.json({ ok: false, error: 'channel_not_found' });
      })
    );
    await expect(slackPost('t', 'C1', 'hello')).rejects.toThrow('Slack post failed: channel_not_found');
    expect(calls).toBe(1);
  });

  it('reading a thread and updating a message retry after a dropped connection (repeating them is harmless)', async () => {
    let reads = 0;
    let updates = 0;
    server.use(
      http.get('https://slack.com/api/conversations.replies', () => {
        reads += 1;
        return reads === 1 ? HttpResponse.error() : HttpResponse.json({ ok: true, messages: [{ ts: '1' }] });
      }),
      http.post('https://slack.com/api/chat.update', () => {
        updates += 1;
        return updates === 1 ? new HttpResponse(null, { status: 503 }) : HttpResponse.json({ ok: true });
      })
    );
    await expect(getThreadHistory('t', 'C1', '1')).resolves.toEqual([{ ts: '1' }]);
    await expect(slackUpdateMessage('t', 'C1', '1', 'x')).resolves.toMatchObject({ ok: true });
    expect(reads).toBe(2);
    expect(updates).toBe(2);
  });
});
