// lib/correspondent-history.js
// Shared per-contact correspondence stats, generalized from what was
// backfill-draft-candidates.js's local normalizeEmail/isExternalContact/
// buildContactStats/loadContactHistory. Counts inbound (Inbox) and outbound
// (SentItems) mail per external contact across email_messages -- this is the
// building block for "how much history do we have with this person," used
// both to gate draft-candidate creation and (via loadCorrespondentStatsMap)
// to decide whether the morning digest should show correspondence context
// for a sender.

export function normalizeEmail(value) {
  return (value || '').trim().toLowerCase();
}

// Domain is derived from ownerEmail rather than a second hardcoded constant,
// so this stays correct if the owner mailbox ever changes.
export function isExternalContact(email, ownerEmail) {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  const ownerNormalized = normalizeEmail(ownerEmail);
  if (normalized === ownerNormalized) return false;
  const domain = ownerNormalized.split('@')[1];
  return !(domain && normalized.endsWith(`@${domain}`));
}

function recipientAddresses(message) {
  return [...(message.recipients || []), ...(message.cc_recipients || [])]
    .map(recipient => normalizeEmail(recipient?.emailAddress?.address || recipient?.address))
    .filter(Boolean);
}

export async function loadContactHistory(supabase, ownerEmail, { days = 365, maxMessages = 2500 } = {}) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('email_messages')
    .select('id, graph_message_id, graph_conversation_id, folder, subject, sender_email, recipients, cc_recipients, received_at, sent_at')
    .eq('owner_email', ownerEmail)
    .or(`received_at.gte.${since},sent_at.gte.${since}`)
    .order('received_at', { ascending: false, nullsFirst: false })
    .limit(maxMessages);

  if (error) throw new Error(`Contact history load failed: ${error.message}`);
  return data || [];
}

export function buildContactStats(messages, ownerEmail) {
  const stats = new Map();

  function ensure(email) {
    const normalized = normalizeEmail(email);
    if (!stats.has(normalized)) {
      stats.set(normalized, {
        email: normalized,
        inbound_count: 0,
        outbound_count: 0,
        conversations: new Map(),
        last_message_at: null,
        last_subject: null,
      });
    }
    return stats.get(normalized);
  }

  function markConversation(contactStats, conversationId, direction) {
    if (!conversationId) return;
    const current = contactStats.conversations.get(conversationId) || { inbound: 0, outbound: 0 };
    current[direction] += 1;
    contactStats.conversations.set(conversationId, current);
  }

  function noteLatest(contactStats, message) {
    const at = message.received_at || message.sent_at || null;
    if (at && (!contactStats.last_message_at || at > contactStats.last_message_at)) {
      contactStats.last_message_at = at;
      contactStats.last_subject = message.subject || contactStats.last_subject;
    }
  }

  for (const message of messages) {
    const folder = message.folder;
    const conversationId = message.graph_conversation_id || message.graph_message_id;

    if (folder === 'Inbox' && isExternalContact(message.sender_email, ownerEmail)) {
      const contactStats = ensure(message.sender_email);
      contactStats.inbound_count += 1;
      markConversation(contactStats, conversationId, 'inbound');
      noteLatest(contactStats, message);
    }

    if (folder === 'SentItems') {
      for (const recipient of recipientAddresses(message)) {
        if (!isExternalContact(recipient, ownerEmail)) continue;
        const contactStats = ensure(recipient);
        contactStats.outbound_count += 1;
        markConversation(contactStats, conversationId, 'outbound');
        noteLatest(contactStats, message);
      }
    }
  }

  for (const contactStats of stats.values()) {
    contactStats.back_and_forth_thread_count = [...contactStats.conversations.values()]
      .filter(conversation => conversation.inbound > 0 && conversation.outbound > 0)
      .length;
    contactStats.known_contact_score =
      contactStats.back_and_forth_thread_count * 10
      + Math.min(contactStats.inbound_count, 10)
      + Math.min(contactStats.outbound_count, 10);
  }

  return stats;
}

export async function loadCorrespondentStatsMap(supabase, ownerEmail, options) {
  const messages = await loadContactHistory(supabase, ownerEmail, options);
  return buildContactStats(messages, ownerEmail);
}
