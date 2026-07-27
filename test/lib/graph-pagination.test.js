import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { getGraphToken, fetchAllPages } from '../../lib/graph';

function page(items, nextLink) {
  return HttpResponse.json({
    value: items,
    ...(nextLink && { '@odata.nextLink': nextLink }),
  });
}

describe('fetchAllPages', () => {
  it('follows @odata.nextLink across 4 pages and all items arrive', async () => {
    let call = 0;
    server.use(
      http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:folder/messages', () => {
        call += 1;
        if (call === 1) return page([{ id: 'a' }, { id: 'b' }], 'https://graph.microsoft.com/v1.0/page2');
        return page([{ id: 'unreachable-via-relative-path' }]);
      }),
      http.get('https://graph.microsoft.com/v1.0/page2', () =>
        page([{ id: 'c' }, { id: 'd' }], 'https://graph.microsoft.com/v1.0/page3')
      ),
      http.get('https://graph.microsoft.com/v1.0/page3', () =>
        page([{ id: 'e' }, { id: 'f' }], 'https://graph.microsoft.com/v1.0/page4')
      ),
      http.get('https://graph.microsoft.com/v1.0/page4', () => page([{ id: 'g' }, { id: 'h' }]))
    );

    const token = await getGraphToken();
    const { items, truncated } = await fetchAllPages(token, '/users/test@example.com/mailFolders/Inbox/messages', {
      maxPages: 10,
      maxItems: 200,
    });

    expect(items.map(i => i.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    expect(truncated).toBe(false);
  });

  it('stops at maxItems and reports truncated', async () => {
    server.use(
      http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:folder/messages', () =>
        page(
          Array.from({ length: 10 }, (_, i) => ({ id: `p1-${i}` })),
          'https://graph.microsoft.com/v1.0/page2'
        )
      ),
      http.get('https://graph.microsoft.com/v1.0/page2', () =>
        page(Array.from({ length: 10 }, (_, i) => ({ id: `p2-${i}` })))
      )
    );

    const token = await getGraphToken();
    const { items, truncated } = await fetchAllPages(token, '/users/test@example.com/mailFolders/Inbox/messages', {
      maxPages: 10,
      maxItems: 15,
    });

    expect(items).toHaveLength(15);
    expect(truncated).toBe(true);
  });

  it('stops at maxPages even if more pages remain, and reports truncated', async () => {
    let call = 0;
    server.use(
      http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:folder/messages', () => {
        call += 1;
        return page([{ id: `page1-item` }], 'https://graph.microsoft.com/v1.0/loop');
      }),
      http.get('https://graph.microsoft.com/v1.0/loop', () => page([{ id: 'loop-item' }], 'https://graph.microsoft.com/v1.0/loop'))
    );

    const token = await getGraphToken();
    const { items, truncated } = await fetchAllPages(token, '/users/test@example.com/mailFolders/Inbox/messages', {
      maxPages: 3,
      maxItems: 200,
    });

    expect(items).toHaveLength(3);
    expect(truncated).toBe(true);
  });

  it('returns truncated: false for a single page with no nextLink', async () => {
    server.use(
      http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:folder/messages', () =>
        page([{ id: 'only' }])
      )
    );

    const token = await getGraphToken();
    const { items, truncated } = await fetchAllPages(token, '/users/test@example.com/mailFolders/Inbox/messages');

    expect(items).toHaveLength(1);
    expect(truncated).toBe(false);
  });
});
