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
export async function callClaude({ model = DEFAULT_MODEL, system, messages, tools, maxTokens }) {
  return anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages,
    ...(tools && { tools }),
  });
}
