import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import { runDigest } from '../pages/api/digest';
import { DIGEST_FIXTURE_EMAILS } from './fixtures/digest-emails';

function page(items, nextLink) {
  return HttpResponse.json({
    value: items,
    ...(nextLink && { '@odata.nextLink': nextLink }),
  });
}

describe('digest.js follows Graph pagination', () => {
  it('follows @odata.nextLink across multiple pages and every email reaches the triage prompt', async () => {
    const page1 = DIGEST_FIXTURE_EMAILS.slice(0, 5);
    const page2 = DIGEST_FIXTURE_EMAILS.slice(5, 10);
    const page3 = DIGEST_FIXTURE_EMAILS.slice(10, 15);
    let firstPageCalls = 0;
    let triagePromptContent = null;

    server.use(
      http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:folder/messages', () => {
        firstPageCalls += 1;
        return page(page1, 'https://graph.microsoft.com/v1.0/inbox-page-2');
      }),
      http.get('https://graph.microsoft.com/v1.0/inbox-page-2', () =>
        page(page2, 'https://graph.microsoft.com/v1.0/inbox-page-3')
      ),
      http.get('https://graph.microsoft.com/v1.0/inbox-page-3', () => page(page3)),
      http.post('https://api.anthropic.com/v1/messages', async ({ request }) => {
        const body = await request.json();
        const system = typeof body.system === 'string' ? body.system : (body.system?.[0]?.text || '');
        if (system.includes('morning email triage assistant')) {
          triagePromptContent = body.messages[0].content;
        }
        const text = system.includes('morning email triage assistant')
          ? '*🌅 Morning Digest*\n\n15 emails total — 0 need action'
          : '[]';
        return HttpResponse.json({
          id: 'm', type: 'message', role: 'assistant',
          content: [{ type: 'text', text }], stop_reason: 'end_turn',
        });
      })
    );

    await runDigest();

    expect(firstPageCalls).toBe(1);
    expect(triagePromptContent).not.toBeNull();
    // Every page's emails made it into the final triage input, not just the first.
    for (const email of [...page1, ...page2, ...page3]) {
      expect(triagePromptContent).toContain(email.subject);
    }
  });
});
