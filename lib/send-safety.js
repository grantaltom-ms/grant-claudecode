// lib/send-safety.js
// Two independent, complementary safety checks for outbound mail, adapted
// from littlebearapps/outlook-assistant's allowlist + rate-limit pattern
// (docs/PLAN-outlook-mcp-inspired-features.md, item 1).
//
// A strict allowlist doesn't fit this system -- Grant emails new tenants,
// vendors, and one-off contacts as normal business, so blocking unknown
// recipients would break real usage constantly. Instead:
//   - checkSendRateLimit / recordSend are a HARD backstop: a runaway loop or
//     a bad approval can only send so many emails in a day before this
//     refuses, regardless of who the recipient is.
//   - flagNewRecipients is ADVISORY only: it never blocks a draft, it just
//     surfaces "first time emailing this address" so Grant sees it before
//     approving a send.

const DEFAULT_MAX_SENDS_PER_DAY = 25;

function trustedDomains() {
  return (process.env.TRUSTED_DOMAINS || 'milestoneproperties.net')
    .split(',')
    .map(d => d.trim().toLowerCase())
    .filter(Boolean);
}

// `Number(x) || DEFAULT` would silently turn an intentional
// MAX_SENDS_PER_DAY=0 (block all sends) into the 25-send default, since 0 is
// falsy -- this only falls back when the value is genuinely unset/invalid.
function resolveMaxSendsPerDay() {
  const raw = process.env.MAX_SENDS_PER_DAY;
  if (raw === undefined || raw === '') return DEFAULT_MAX_SENDS_PER_DAY;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_MAX_SENDS_PER_DAY;
}

export async function checkSendRateLimit(supabase, ownerEmail) {
  const limit = resolveMaxSendsPerDay();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { count, error } = await supabase
    .from('send_log')
    .select('id', { count: 'exact', head: true })
    .eq('owner_email', ownerEmail)
    .gte('sent_at', since);

  if (error) {
    console.error('checkSendRateLimit query failed:', error);
    // Fail open -- a broken safety check must not become a full send outage
    // -- but this is logged loudly precisely because it should be rare.
    return { allowed: true, count: null, limit, error: error.message };
  }

  return { allowed: (count ?? 0) < limit, count: count ?? 0, limit };
}

export async function recordSend(supabase, ownerEmail, recipients, messageId) {
  const rows = (recipients || [])
    .filter(Boolean)
    .map(recipient => ({ owner_email: ownerEmail, recipient, message_id: messageId || null }));

  if (rows.length === 0) return;

  const { error } = await supabase.from('send_log').insert(rows);
  if (error) console.error('recordSend insert failed:', error);
}

// jsonb containment (`@>`) is a structural, case-sensitive match, so this can
// under-flag when stored address casing differs from the address being
// checked. Acceptable for an advisory-only signal -- worst case is a known
// contact occasionally shown as "first time."
async function hasPriorCorrespondence(supabase, ownerEmail, address) {
  const [sender, recipient, cc] = await Promise.all([
    supabase.from('email_messages').select('id').eq('owner_email', ownerEmail).ilike('sender_email', address).limit(1),
    supabase.from('email_messages').select('id').eq('owner_email', ownerEmail).contains('recipients', [{ emailAddress: { address } }]).limit(1),
    supabase.from('email_messages').select('id').eq('owner_email', ownerEmail).contains('cc_recipients', [{ emailAddress: { address } }]).limit(1),
  ]);
  return Boolean(sender.data?.length || recipient.data?.length || cc.data?.length);
}

// Returns the subset of `addresses` that are neither on a trusted domain nor
// found anywhere in this mailbox's saved history (as sender, To, or Cc).
// Never blocks -- callers surface the result as a note, not a refusal.
export async function flagNewRecipients(supabase, ownerEmail, addresses) {
  const trusted = trustedDomains();
  const candidates = [...new Set((addresses || []).filter(Boolean).map(a => a.toLowerCase()))]
    .filter(address => !trusted.some(domain => address.endsWith(`@${domain}`)));

  if (candidates.length === 0) return [];

  const results = await Promise.all(
    candidates.map(async address => ({
      address,
      known: await hasPriorCorrespondence(supabase, ownerEmail, address),
    }))
  );

  return results.filter(r => !r.known).map(r => r.address);
}
