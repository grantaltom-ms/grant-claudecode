// lib/graph.js
// Shared Microsoft Graph API helpers: token acquisition/caching, a request
// wrapper, and pagination support for following @odata.nextLink.

import { withRetry } from './retry';

let cachedToken = null;
let tokenExpiry = 0;

export async function getGraphToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60_000) return cachedToken;

  const data = await withRetry(async () => {
    const res = await fetch(
      `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: process.env.AZURE_CLIENT_ID,
          client_secret: process.env.AZURE_CLIENT_SECRET,
          scope: 'https://graph.microsoft.com/.default',
        }),
      }
    );
    const json = await res.json();
    if (!json.access_token) {
      const err = new Error(`Graph auth failed: ${JSON.stringify(json)}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }, { label: 'graph-token' });

  cachedToken = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

async function graphRequestOnce(url, token, method, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      ...(body && { body: JSON.stringify(body) }),
    });
  } catch (err) {
    // A network-level failure (timeout, DNS, connection reset) on a GET is safe
    // to retry -- nothing was mutated. On a mutating call (POST/PATCH/DELETE)
    // it's genuinely ambiguous whether Graph processed the request before the
    // response was lost, so it must NOT be auto-retried here (status left
    // undefined would make withRetry treat it as retryable) -- tagging it with
    // a non-retryable status forces the caller to decide, the same way a real
    // "check before you send again" guard would. See Phase 7 for send_draft's
    // own guard against double-sends.
    if (method !== 'GET') err.status = 0;
    throw err;
  }

  if (res.status === 202 || res.status === 204) return { success: true };

  const text = await res.text();
  const json = text ? JSON.parse(text) : null;

  // Every pre-consolidation copy of this function only checked `json.error`,
  // so a non-2xx response with no Graph-shaped error body (e.g. a bare 429/503)
  // was silently returned as success. Checking `res.ok` too is a deliberate
  // fix, not just a refactor — Phase 6's retry logic needs err.status set on
  // every failure, retryable or not, to tell them apart.
  if (!res.ok || json?.error) {
    const message = json?.error?.message || res.statusText || `HTTP ${res.status}`;
    const err = new Error(`Graph error: ${message}`);
    err.status = res.status;
    const retryAfter = res.headers.get('retry-after');
    if (retryAfter) err.retryAfterMs = Number(retryAfter) * 1000;
    throw err;
  }

  return json || { success: true };
}

function graphRequest(url, token, method = 'GET', body = null) {
  return withRetry(() => graphRequestOnce(url, token, method, body), { label: `graph ${method} ${url}` });
}

export async function graph(token, path, method = 'GET', body = null) {
  return graphRequest(`https://graph.microsoft.com/v1.0${path}`, token, method, body);
}

// @odata.nextLink is returned by Graph as a fully-qualified URL — use this
// instead of graph() to follow it, rather than prefixing it a second time.
export async function graphAbsolute(token, url) {
  return graphRequest(url, token);
}

// Follows @odata.nextLink across pages, bounded by both maxPages and
// maxItems so a genuinely huge mailbox can't turn one digest run into an
// unbounded crawl. Returns { items, truncated } -- truncated is true when
// either bound was hit before Graph ran out of pages, so callers can surface
// that to the volume-cap footer instead of silently dropping the oldest
// unprocessed items.
export async function fetchAllPages(token, initialPath, { maxPages = 10, maxItems = 200 } = {}) {
  const items = [];
  let nextLink = null;
  let pages = 0;
  let truncated = false;

  while (pages < maxPages) {
    const result = nextLink ? await graphAbsolute(token, nextLink) : await graph(token, initialPath);
    pages += 1;

    for (const item of result.value || []) {
      if (items.length >= maxItems) {
        truncated = true;
        break;
      }
      items.push(item);
    }
    if (truncated) break;

    nextLink = result['@odata.nextLink'] || null;
    if (!nextLink) break;
  }

  if (nextLink && !truncated) truncated = true;

  return { items, truncated };
}
