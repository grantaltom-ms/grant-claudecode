// lib/retry.js
// Shared retry/backoff wrapper for external calls (Graph, Anthropic, Slack,
// OpenAI). Retries transient failures (429/5xx/network errors); does not
// retry other 4xx, since e.g. a 404 on a deleted message will never succeed.
// Honors a Retry-After header (surfaced as err.retryAfterMs by lib/graph.js)
// over its own exponential backoff.

export async function withRetry(fn, { attempts = 3, baseMs = 500, label = '' } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.status ?? err.statusCode;
      const retryable = status === 429 || (status >= 500 && status < 600) || status === undefined;
      if (!retryable || i === attempts - 1) throw err;
      const wait = err.retryAfterMs ?? baseMs * 2 ** i + Math.random() * 250;
      console.warn(`[retry] ${label} attempt ${i + 1} failed (${status}), waiting ${Math.round(wait)}ms`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}
