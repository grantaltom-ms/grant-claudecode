// lib/graph.js
// Shared Microsoft Graph API helpers: token acquisition/caching, a request
// wrapper, and pagination support for following @odata.nextLink.

let cachedToken = null;
let tokenExpiry = 0;

export async function getGraphToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60_000) return cachedToken;

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

  const data = await res.json();
  if (!data.access_token) throw new Error(`Graph auth failed: ${JSON.stringify(data)}`);

  cachedToken = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

async function graphRequest(url, token, method = 'GET', body = null) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body && { body: JSON.stringify(body) }),
  });

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

export async function graph(token, path, method = 'GET', body = null) {
  return graphRequest(`https://graph.microsoft.com/v1.0${path}`, token, method, body);
}

// @odata.nextLink is returned by Graph as a fully-qualified URL — use this
// instead of graph() to follow it, rather than prefixing it a second time.
export async function graphAbsolute(token, url) {
  return graphRequest(url, token);
}

// Pre-send recipient checks (out-of-office, full mailbox, delivery
// restrictions) via Graph's getMailTips. Requires the MailboxSettings.Read
// application permission in addition to Mail.Read/Mail.ReadWrite/Mail.Send —
// see docs/system-reference.md's "Send safety" section. Callers should treat
// failures here as non-fatal (wrap in try/catch): mail tips are advisory,
// and losing them must never block drafting an email.
export async function getMailTips(token, ownerEmail, recipients) {
  if (!recipients || recipients.length === 0) return [];
  const result = await graph(token, `/users/${ownerEmail}/getMailTips`, 'POST', {
    EmailAddresses: recipients,
    MailTipsOptions: 'automaticReplies,mailboxFullStatus,deliveryRestriction',
  });
  return result.value || [];
}

// Turns Graph's raw mailTips array into short human-readable warning lines.
// Per-recipient `error` entries (e.g. mail tips unsupported for an external
// domain) are skipped rather than surfaced as a warning.
export function summarizeMailTips(tips = []) {
  const notes = [];
  for (const tip of tips) {
    const address = tip?.emailAddress?.address;
    if (!address || tip?.error) continue;

    if (tip.automaticReplies?.message) {
      notes.push(`${address} has an out-of-office reply active: "${tip.automaticReplies.message.slice(0, 150)}"`);
    }
    if (tip.mailboxFull) {
      notes.push(`${address}'s mailbox appears full`);
    }
    if (tip.deliveryRestricted) {
      notes.push(`${address} may have delivery restrictions — message could be rejected`);
    }
  }
  return notes;
}

// Walks a Graph delta query session (messages/delta) forward from `startUrl`,
// following @odata.nextLink pages until Graph hands back the terminal
// @odata.deltaLink (the session is caught up) or `maxPages` is reached first.
// The $select fields used on the FIRST call of a brand-new delta session
// persist for the life of that session -- callers establishing a new session
// must request every field they'll ever need from page one, since a later
// call against the resulting deltaLink can't add fields it didn't ask for
// originally.
export async function walkDeltaPages(token, startUrl, { maxPages = 20, startIsAbsolute = false } = {}) {
  let url = startUrl;
  let items = [];
  let pages = 0;
  let deltaLink = null;

  while (url && pages < maxPages) {
    const useAbsolute = pages > 0 || startIsAbsolute;
    const result = useAbsolute ? await graphAbsolute(token, url) : await graph(token, url);
    items = items.concat(result.value || []);
    pages += 1;

    deltaLink = result['@odata.deltaLink'] || null;
    url = result['@odata.nextLink'] || null;
    if (deltaLink) break;
  }

  // If the walk stopped because it hit deltaLink, there's nothing left to
  // resume from; otherwise `url` (possibly null, if Graph's page genuinely
  // had no nextLink either) is where the next call should pick up.
  return { items, deltaLink, nextLink: deltaLink ? null : url, pages };
}
