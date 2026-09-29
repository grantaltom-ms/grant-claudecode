import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { callClaude, DEFAULT_MODEL } from '../../lib/claude';

// Every Claude call in the inbox assistant, digest, and comply agent goes
// through callClaude and inherits DEFAULT_MODEL. These tests pin the model so a
// stray edit (or a dated id that later gets retired) can't slip through.
describe('Claude model', () => {
  it('defaults to Sonnet 5.5', () => {
    expect(DEFAULT_MODEL).toBe('claude-sonnet-5-5');
  });

  it('uses an alias, not a dated id that will eventually be retired', () => {
    expect(DEFAULT_MODEL).not.toMatch(/-\d{8}$/);
  });

  it('sends Sonnet 5.5 on every call, across repeated calls', async () => {
    const seen = [];
    server.use(
      http.post('https://api.anthropic.com/v1/messages', async ({ request }) => {
        const body = await request.json();
        seen.push(body.model);
        return HttpResponse.json({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      })
    );

    for (let i = 0; i < 5; i++) {
      await callClaude({ system: 'sys', messages: [{ role: 'user', content: `hi ${i}` }], maxTokens: 16 });
    }

    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(['claude-sonnet-5-5']));
  });
});
