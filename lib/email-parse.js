// lib/email-parse.js
// Shared helpers for turning Graph message bodies into plain text.

export function htmlToText(html = '') {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractBodyFields(email) {
  const body = email.body || {};
  const content = body.content || null;
  const contentType = (body.contentType || '').toLowerCase();

  if (!content) return { body_text: null, body_html: null };
  if (contentType === 'html') {
    return {
      body_text: htmlToText(content),
      body_html: content
    };
  }

  return {
    body_text: content,
    body_html: null
  };
}

// Microsoft 365 stamps its own SPF/DKIM/DMARC verdicts into the
// Authentication-Results header on inbound mail. This reads that verdict --
// it does not perform any cryptographic verification itself. `headers` is
// Graph's internetMessageHeaders shape: [{ name, value }, ...].
export function parseAuthResults(headers = []) {
  const header = (headers || []).find(
    h => (h?.name || '').toLowerCase() === 'authentication-results'
  );
  const value = header?.value || '';

  const extract = (name) => {
    const match = value.match(new RegExp(`${name}=(\\w+)`, 'i'));
    return match ? match[1].toLowerCase() : null;
  };

  return {
    spf: extract('spf'),
    dkim: extract('dkim'),
    dmarc: extract('dmarc'),
  };
}

// dkim=fail alone is common on legitimately forwarded/mailing-list mail, so
// it's excluded from this hard trigger -- spf/dmarc failing is the stronger
// spoofing signal. All three verdicts are still surfaced to the model.
export function isAuthFailure({ spf, dmarc } = {}) {
  return spf === 'fail' || dmarc === 'fail';
}
