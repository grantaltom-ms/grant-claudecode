import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { stripLoneSurrogates, callClaude } from '../../lib/claude';

// A lone surrogate is what .slice(0, n) leaves behind when it cuts an emoji in
// half -- exactly how pages/api/digest.js truncates email previews.
const CHOPPED_EMOJI = '😀'.slice(0, 1);
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('stripLoneSurrogates', () => {
  it('drops an unpaired high surrogate left by slicing an emoji in half', () => {
    expect(stripLoneSurrogates(`preview ${CHOPPED_EMOJI}`)).toBe('preview ');
  });

  it('drops an unpaired low surrogate', () => {
    expect(stripLoneSurrogates(`x${'\uDC00'}y`)).toBe('xy');
  });

  it('leaves whole emoji, ZWJ sequences, and non-ASCII text untouched', () => {
    for (const text of ['hi 😀 there', '👨‍👩‍👧‍👦 family', 'café 日本語', 'plain ascii', '']) {
      expect(stripLoneSurrogates(text)).toBe(text);
    }
  });
});

describe('callClaude sanitizes outbound request bodies', () => {
  // Regression: a chopped emoji in an email preview made JSON.stringify emit a
  // literal \udXXX escape. The API's strict parser rejected the whole request
  // with 400 "no low surrogate in string", failing the entire morning digest.
  it('strips lone surrogates from messages and the system prompt before sending', async () => {
    let rawBody;
    server.use(
      http.post('https://api.anthropic.com/v1/messages', async ({ request }) => {
        rawBody = await request.text();
        return HttpResponse.json({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
        });
      })
    );

    await callClaude({
      system: [{ type: 'text', text: `system ${CHOPPED_EMOJI}`, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `Preview: ${CHOPPED_EMOJI}` }],
      maxTokens: 64,
    });

    expect(rawBody).not.toMatch(LONE_SURROGATE_RE);
    // The escaped form is what the strict parser actually chokes on.
    expect(rawBody).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);

    const parsed = JSON.parse(rawBody);
    expect(parsed.messages[0].content).toBe('Preview: ');
    expect(parsed.system[0].text).toBe('system ');
    // Sanitizing must not disturb the cached-prompt structure.
    expect(parsed.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('preserves whole emoji and nested content blocks', async () => {
    let parsed;
    server.use(
      http.post('https://api.anthropic.com/v1/messages', async ({ request }) => {
        parsed = await request.json();
        return HttpResponse.json({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
        });
      })
    );

    await callClaude({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Deal 🎉 closed — café' }] },
        { role: 'assistant', content: 'ok 👨‍👩‍👧‍👦' },
      ],
      maxTokens: 64,
    });

    expect(parsed.messages[0].content[0].text).toBe('Deal 🎉 closed — café');
    expect(parsed.messages[1].content).toBe('ok 👨‍👩‍👧‍👦');
  });
});
