// lib/email-thread-memory.js
// Shared email_threads upsert logic, extracted from what were near-identical
// copies in digest.js and backfill-inbox.js. Participant collection (sender +
// to + cc) is direction-agnostic -- for a SentItems message, email.from is
// the owner and toRecipients/ccRecipients are the external contacts, so this
// works unmodified for sent mail too (see backfill-sent-mail.js).

function collectEmailAddresses(recipients = []) {
  return recipients
    .map(recipient => recipient.emailAddress?.address)
    .filter(Boolean);
}

function collectEmailNames(recipients = []) {
  return recipients
    .map(recipient => recipient.emailAddress?.name)
    .filter(Boolean);
}

// `onError(stage, error)` is optional -- callers that track errors in bulk
// (backfill-inbox.js's threadErrors array) can hook in without this function
// needing to know about their reporting shape. Every error is also
// console.error'd regardless of whether onError is provided.
export async function upsertThreadMemory(supabase, ownerEmail, email, { onError } = {}) {
  if (!email.conversationId) return null;

  const sender = email.from?.emailAddress || {};
  const participantEmails = [
    sender.address,
    ...collectEmailAddresses(email.toRecipients),
    ...collectEmailAddresses(email.ccRecipients)
  ].filter(Boolean);
  const participantNames = [
    sender.name,
    ...collectEmailNames(email.toRecipients),
    ...collectEmailNames(email.ccRecipients)
  ].filter(Boolean);

  const { data: existingThread, error: existingError } = await supabase
    .from('email_threads')
    .select('first_message_at,last_message_at,participant_emails,participant_names')
    .eq('graph_conversation_id', email.conversationId)
    .maybeSingle();

  if (existingError) {
    console.error('Failed to load existing thread memory:', {
      graph_conversation_id: email.conversationId,
      error: existingError
    });
    onError?.('load_thread', existingError);
    return null;
  }

  const receivedAt = email.receivedDateTime || email.sentDateTime || null;
  const existingEmails = existingThread?.participant_emails || [];
  const existingNames = existingThread?.participant_names || [];
  const mergedEmails = [...new Set([...existingEmails, ...participantEmails])];
  const mergedNames = [...new Set([...existingNames, ...participantNames])];
  const firstMessageAt = [existingThread?.first_message_at, receivedAt]
    .filter(Boolean)
    .sort()[0] || null;
  const lastMessageCandidates = [existingThread?.last_message_at, receivedAt]
    .filter(Boolean)
    .sort();
  const lastMessageAt = lastMessageCandidates[lastMessageCandidates.length - 1] || null;

  const { count, error: countError } = await supabase
    .from('email_messages')
    .select('id', { count: 'exact', head: true })
    .eq('graph_conversation_id', email.conversationId);

  if (countError) {
    console.error('Failed to count thread messages:', {
      graph_conversation_id: email.conversationId,
      error: countError
    });
    onError?.('count_messages', countError);
  }

  const { data, error } = await supabase
    .from('email_threads')
    .upsert({
      graph_conversation_id: email.conversationId,
      owner_email: ownerEmail,
      latest_subject: email.subject || null,
      participant_emails: mergedEmails,
      participant_names: mergedNames,
      first_message_at: firstMessageAt,
      last_message_at: lastMessageAt,
      last_graph_message_id: email.id,
      message_count: count || 0,
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'graph_conversation_id'
    })
    .select()
    .single();

  if (error) {
    console.error('Failed to upsert thread memory:', {
      graph_conversation_id: email.conversationId,
      subject: email.subject,
      error
    });
    onError?.('upsert_thread', error);
    return null;
  }

  return data;
}
