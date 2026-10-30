// lib/retry.js
// Shared retry/backoff for calls to outside services (Microsoft Graph, Slack).
//
// Retries only failures that are worth another try: 429 (rate limited), 5xx and
// network errors. Other 4xx never succeed on a second try (a 404 on a deleted
// message stays a 404), so they fail at once.
//
// Callers whose request DOES something (send an email, post a message) must
// pass a narrower `retryOn`: after a network error or a 500 the first attempt
// may already have gone through, and a retry would send it twice. Retry those
// only on an explicit "not processed" answer such as 429 or 503.
//
// Anthropic calls are not wrapped: the Anthropic SDK already retries 429/5xx
// itself (maxRetries, default 2).

const MAX_WAIT_MS = 10_000; // stay well inside Vercel's function time limits

export function isTransient(err) {
  const status = err?.status ?? err?.statusCode;
  return status === undefined || status === 429 || (status >= 500 && status < 600);
}

/** Only an explicit "rejected, nothing was processed" answer. Safe for calls that send or create things. */
export function isExplicitRejection(err) {
  const status = err?.status ?? err?.statusCode;
  return status === 429 || status === 503;
}

export async function withRetry(fn, { attempts = 3, baseMs = 500, label = '', retryOn = isTransient } = {}) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts - 1 || !retryOn(err)) throw err;
      const wait = Math.min(err.retryAfterMs ?? baseMs * 2 ** i + Math.random() * 250, MAX_WAIT_MS);
      console.warn(`[retry] ${label} attempt ${i + 1} failed (${err.status ?? err.message}), waiting ${Math.round(wait)}ms`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}
