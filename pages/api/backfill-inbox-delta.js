// pages/api/backfill-inbox-delta.js
//
// One-time (resumable) backfill that establishes the delta-sync cursor
// digest.js needs. Deliberately decoupled from the live digest cron: this
// endpoint never touches digest.js's fetch path, so digest.js keeps working
// exactly as it does today (a plain 24h window pull) until this backfill
// finishes and switches inbox_delta_state.is_bootstrapped to true.
//
// Microsoft Graph's mail delta query doesn't support filtering by
// receivedDateTime, so establishing the first delta cursor requires walking
// the ENTIRE Inbox folder once -- for an actively-managed mailbox that can
// be many pages. This endpoint processes up to `max_pages` pages per call
// and persists its progress, so call it repeatedly (e.g. from a shell loop)
// until the response reports bootstrap_complete: true.
//
// See docs/PLAN-outlook-mcp-inspired-features.md, item 4.

import { supabase } from '../../lib/supabase';
import { getGraphToken, walkDeltaPages } from '../../lib/graph';

const OWNER_EMAIL = 'grant@milestoneproperties.net';

// Must match the $select digest.js's delta fetch relies on (see
// digest.js's INBOX_SELECT_FIELDS) -- the fields requested on this first
// call are the only fields the resulting delta session will ever return.
const SELECT_FIELDS = 'id,conversationId,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,body,bodyPreview,importance,hasAttachments,internetMessageHeaders';

function verifyCronRequest(req) {
  return req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
}

function boundedInteger(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

export async function runInboxDeltaBackfill({ maxPages = 20 } = {}) {
  const { data: existing, error: loadError } = await supabase
    .from('inbox_delta_state')
    .select('cursor_url, is_bootstrapped')
    .eq('owner_email', OWNER_EMAIL)
    .maybeSingle();

  if (loadError) {
    return { status: 500, body: { error: 'Failed to load inbox_delta_state', details: loadError.message } };
  }

  if (existing?.is_bootstrapped) {
    return {
      status: 200,
      body: {
        ok: true,
        already_bootstrapped: true,
        message: 'Delta sync is already bootstrapped for this mailbox -- digest.js is using it. Nothing to do.',
      },
    };
  }

  const token = await getGraphToken();
  const startUrl = existing?.cursor_url
    || `/users/${OWNER_EMAIL}/mailFolders/Inbox/messages/delta?$top=50&$select=${SELECT_FIELDS}`;

  const { items, deltaLink, nextLink, pages } = await walkDeltaPages(token, startUrl, {
    maxPages,
    startIsAbsolute: Boolean(existing?.cursor_url),
  });

  const cursorUrl = deltaLink || nextLink;
  const isBootstrapped = Boolean(deltaLink);

  const { error: saveError } = await supabase
    .from('inbox_delta_state')
    .upsert({
      owner_email: OWNER_EMAIL,
      cursor_url: cursorUrl,
      is_bootstrapped: isBootstrapped,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'owner_email' });

  if (saveError) {
    return { status: 500, body: { error: 'Failed to save inbox_delta_state', details: saveError.message } };
  }

  return {
    status: 200,
    body: {
      ok: true,
      pages_walked_this_call: pages,
      messages_seen_this_call: items.length,
      bootstrap_complete: isBootstrapped,
      message: isBootstrapped
        ? 'Delta sync bootstrap complete. digest.js will use delta fetch on its next run.'
        : `Bootstrap in progress (${pages} page${pages === 1 ? '' : 's'} walked this call) -- call this endpoint again to continue from where it left off.`,
    },
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).end();
  if (!verifyCronRequest(req)) return res.status(401).json({ error: 'Unauthorized' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({
      error: 'Missing Supabase environment variables: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY'
    });
  }

  const maxPages = boundedInteger(req.query.max_pages, 20, 50);
  const { status, body } = await runInboxDeltaBackfill({ maxPages });
  return res.status(status).json(body);
}
