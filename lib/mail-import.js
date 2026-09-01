// lib/mail-import.js
// Historical mail import/export via Microsoft Graph, requiring the
// MailboxItem.ImportExport application permission (see
// docs/system-reference.md). A plain Mail.ReadWrite message create ignores
// receivedDateTime/sentDateTime -- Graph stamps them with the actual send
// time regardless of what's posted. MailboxItem.ImportExport is what makes
// Graph honor those fields on create, which is what migration/import
// tooling needs to preserve a message's true original date instead of
// showing "today" for something that happened months or years ago.
//
// Use this for genuinely historical content (e.g. correspondence recovered
// from a legacy system or a paper record that needs to live in Outlook with
// its real date) -- not as a substitute for create_new_draft/send_draft for
// anything Grant is actually sending now.

import { graph } from './graph';

// Creates a message directly in the given folder with the supplied
// timestamps preserved. `isDraft: false` combined with an explicit
// `receivedDateTime` is the shape Graph expects for an imported item; the
// message is never sent, it simply appears already delivered.
export async function importMessage(token, ownerEmail, folderId, {
  subject,
  bodyText,
  fromAddress,
  fromName,
  toAddresses = [],
  receivedDateTime,
  sentDateTime,
  isRead = true,
  internetMessageId,
}) {
  if (!receivedDateTime) throw new Error('importMessage requires receivedDateTime to preserve the original date.');

  const payload = {
    subject,
    body: { contentType: 'Text', content: bodyText || '' },
    isDraft: false,
    isRead,
    receivedDateTime,
    sentDateTime: sentDateTime || receivedDateTime,
    ...(fromAddress && { from: { emailAddress: { address: fromAddress, name: fromName || fromAddress } } }),
    ...(toAddresses.length && { toRecipients: toAddresses.map(address => ({ emailAddress: { address } })) }),
    ...(internetMessageId && { internetMessageId }),
  };

  return graph(token, `/users/${ownerEmail}/mailFolders/${folderId}/messages`, 'POST', payload);
}

// Raw MIME (RFC 2822) export of a message via Graph's $value endpoint --
// full headers, original formatting, and structure, for cases where a
// summary/body preview isn't enough (e.g. proving exact send time or
// producing a record for a dispute).
//
// $value returns raw MIME text, not JSON, so this bypasses graph()'s
// response parsing (which assumes a JSON body) and fetches directly.
export async function exportMessageMime(token, ownerEmail, messageId) {
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${ownerEmail}/messages/${messageId}/$value`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Graph MIME export failed: HTTP ${res.status} ${text}`.trim());
  }
  return res.text();
}
