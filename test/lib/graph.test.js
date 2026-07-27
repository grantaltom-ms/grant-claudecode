import { describe, it, expect } from 'vitest';
import { getGraphToken, graph } from '../../lib/graph';

describe('lib/graph', () => {
  it('fetches and returns a token', async () => {
    const token = await getGraphToken();
    expect(token).toBe('test-graph-token');
  });

  it('makes an authenticated request against a relative path', async () => {
    const token = await getGraphToken();
    const result = await graph(token, '/users/test@example.com/mailFolders/Inbox/messages');
    expect(result.value).toEqual([]);
  });
});
