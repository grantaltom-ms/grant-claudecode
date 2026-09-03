// lib/claude.js
// Thin wrapper around the Anthropic client, centralizing the model string
// that was previously hardcoded at 10 call sites across the repo.

import Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_MODEL = 'claude-sonnet-4-6';

export const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// `system` is passed through as-is rather than normalized to a string, since
// the inbox-assistant tool-use loop relies on the array form
// (`[{ type: 'text', text, cache_control: { type: 'ephemeral' } }]`) to enable
// prompt caching — flattening it here would silently disable that.
// Default 60s — long enough for a normal tool-use turn, short enough that a
 // hung Anthropic socket fails before Vercel's function maxDuration silently
 // kills the isolate (which skips our Slack error reply after "_On it..._").
export const DEFAULT_CALL_TIMEOUT_MS = 60_000;

// Drops unpaired UTF-16 surrogates. JSON.stringify serializes a lone surrogate
// as a literal \udXXX escape -- valid to JavaScript, but strict parsers (the
// one behind the Anthropic API included) reject it with "no low surrogate in
// string" and fail the whole request with a 400. Lone surrogates reach us two
// ways: truncating text with .slice(0, n) can cut an emoji's surrogate pair in
// half (see the preview truncations in pages/api/digest.js), and Graph itself
// occasionally returns mail bodies containing them.
export function stripLoneSurrogates(text) {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

function sanitize(value) {
  if (typeof value === 'string') return stripLoneSurrogates(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v)]));
  }
  return value;
}

export async function callClaude({
  model = DEFAULT_MODEL,
  system,
  messages,
  tools,
  maxTokens,
  timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await anthropic.messages.create(
      {
        model,
        max_tokens: maxTokens,
        system: sanitize(system),
        messages: sanitize(messages),
        ...(tools && { tools }),
      },
      { signal: controller.signal }
    );
  } catch (err) {
    if (err?.name === 'AbortError' || controller.signal.aborted) {
      throw new Error(`Claude API timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
