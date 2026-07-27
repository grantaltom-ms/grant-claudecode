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
