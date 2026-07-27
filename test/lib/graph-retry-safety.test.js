import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { graph, getGraphToken } from '../../lib/graph';

describe('graph() retry safety for non-idempotent calls', () => {
  it('retries a GET on a network-level failure', async () => {
    let calls = 0;
    server.use(
      http.get('https://graph.microsoft.com/v1.0/users/:email/messages/:id', () => {
        calls += 1;
        if (calls < 2) return HttpResponse.error();
        return HttpResponse.json({ id: 'ok' });
      })
    );

    const token = await getGraphToken();
    const result = await graph(token, '/users/test@example.com/messages/abc');

    expect(result).toEqual({ id: 'ok' });
    expect(calls).toBe(2);
  });

  it('does NOT retry a POST (e.g. /send) on a network-level failure -- avoids a possible duplicate send', async () => {
    let calls = 0;
    server.use(
      http.post('https://graph.microsoft.com/v1.0/users/:email/messages/:id/send', () => {
        calls += 1;
        return HttpResponse.error();
      })
    );

    const token = await getGraphToken();
    await expect(graph(token, '/users/test@example.com/messages/abc/send', 'POST')).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('DOES retry a POST on a 429/503 -- Graph explicitly rejected it, nothing was processed', async () => {
    let calls = 0;
    server.use(
      http.post('https://graph.microsoft.com/v1.0/users/:email/messages/:id/move', () => {
        calls += 1;
        if (calls < 2) return new HttpResponse(null, { status: 503 });
        return HttpResponse.json({ id: 'archived' });
      })
    );

    const token = await getGraphToken();
    const result = await graph(token, '/users/test@example.com/messages/abc/move', 'POST', { destinationId: 'archive' });

    expect(result).toEqual({ id: 'archived' });
    expect(calls).toBe(2);
  });
});
