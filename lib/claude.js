// lib/claude.js
// Thin wrapper around the Anthropic client, centralizing the model string
// that was previously hardcoded at 10 call sites across the repo.

import Anthropic from '@anthropic-ai/sdk';
import { withRetry } from './retry';

export const DEFAULT_MODEL = 'claude-sonnet-4-6';

// maxRetries: 0 -- the SDK has its own built-in retry behavior, but we want
// one consistent retry/backoff/logging policy (lib/retry.js) across Graph,
// Anthropic, Slack, and OpenAI rather than the SDK silently retrying beneath
// withRetry and compounding attempts.
export const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });

// `system` is passed through as-is rather than normalized to a string, since
// the inbox-assistant tool-use loop relies on the array form
// (`[{ type: 'text', text, cache_control: { type: 'ephemeral' } }]`) to enable
// prompt caching — flattening it here would silently disable that.
export async function callClaude({ model = DEFAULT_MODEL, system, messages, tools, maxTokens }) {
  return withRetry(() => anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages,
    ...(tools && { tools }),
  }), { label: 'anthropic messages.create' });
}
