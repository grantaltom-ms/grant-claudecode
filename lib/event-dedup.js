// lib/event-dedup.js
// Slack retries an Events API delivery if it doesn't get a fast-enough 200
// (or on any transient error on its end), so the same event_id can arrive
// more than once. Both raw event handlers (pages/api/comply-vacate.js,
// pages/api/inbox-assistant.js) claim the event_id here before doing any
// work; a conflict means it's already been -- or is already being --
// processed, so the caller should return 200 and do nothing else.

import { supabase } from './supabase';

// Returns true if this is the first time we've seen eventId (caller should
// process it), false if it's already claimed (caller should skip).
export async function claimSlackEvent(eventId) {
  if (!eventId) return true; // nothing to dedup on -- don't block processing

  const { error } = await supabase
    .from('processed_slack_events')
    .insert({ event_id: eventId });

  if (!error) return true;
  if (error.code === '23505') return false; // unique_violation -- already claimed

  // Fail open: a dedup-table hiccup should never block real Slack traffic.
  console.error('claimSlackEvent failed, processing anyway:', error);
  return true;
}
