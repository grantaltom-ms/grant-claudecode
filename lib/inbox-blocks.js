// lib/inbox-blocks.js
// Block Kit builders for the inbox assistant's calendar approval flow.
// Deliberately does not import lib/comply-blocks.js -- that module's
// formatResolvedMessage strips a comply-only APPROVE_OR_REVISE sentinel that
// has no meaning here, so a shared import would be a subtle trap rather than
// real reuse. The 2900-char chunking helper is small enough to duplicate.

export const CALENDAR_ACTIONS = {
  APPLY: 'calendar_apply',
  EDIT: 'calendar_edit',
  DISCARD: 'calendar_discard',
};

const MAX_SECTION_TEXT_LENGTH = 2900;

function buildMarkdownSectionBlocks(text) {
  const normalizedText = (text || '').trim() || ' ';
  const blocks = [];
  for (let i = 0; i < normalizedText.length; i += MAX_SECTION_TEXT_LENGTH) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: normalizedText.slice(i, i + MAX_SECTION_TEXT_LENGTH) },
    });
  }
  return blocks;
}

// calendar_event_drafts.start_time/end_time are bare wall-clock strings
// (e.g. "2026-09-04T07:00:00") paired with a separate time_zone column --
// see migration 025_calendar_event_drafts_text_datetimes.sql. Formatting
// with Date.UTC + a UTC-pinned Intl formatter reads those digits back out
// exactly as given, regardless of the server's own time zone.
function formatWallClock(wallClock) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(wallClock || '');
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number);
  const asUtc = new Date(Date.UTC(y, mo - 1, d, h, mi));
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  }).format(asUtc);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(asUtc);
  return { date, time };
}

// Human-readable summary of a staged draft. Used both as the Block Kit
// section text and as the plain-text fallback slackPost sends alongside the
// blocks -- so it must never be empty (Slack rejects an empty section, and
// runAgent rebuilds conversation history from this exact text).
export function formatCalendarSummary(draft) {
  const zone = draft.time_zone || 'America/Los_Angeles';
  const lines = [];

  if (draft.action === 'cancel') {
    lines.push(`🗑️ *Cancel event*${draft.target_event_id ? ` (id ${draft.target_event_id})` : ''}`);
    if (draft.cancel_comment) lines.push(`Note: ${draft.cancel_comment}`);
  } else {
    lines.push(draft.action === 'update' ? '✏️ *Update event*' : `📅 *${draft.subject || 'Untitled event'}*`);
    if (draft.action === 'update' && draft.subject) lines.push(`*${draft.subject}*`);

    const start = formatWallClock(draft.start_time);
    const end = formatWallClock(draft.end_time);
    if (start && end) {
      lines.push(`${start.date} · ${start.time} – ${end.time} (${zone})`);
    } else if (draft.start_time || draft.end_time) {
      lines.push(`${draft.start_time || '?'} – ${draft.end_time || '?'} (${zone})`);
    }

    if (draft.location) lines.push(`📍 ${draft.location}`);
    if (draft.attendees?.length) lines.push(`👥 ${draft.attendees.join(', ')}`);
  }

  const text = lines.join('\n').trim();
  return text || `📅 Calendar ${draft.action || 'create'}`;
}

function applyButtonLabel(action) {
  if (action === 'cancel') return '✅ Cancel it';
  if (action === 'update') return '✅ Apply';
  return '✅ Book it';
}

// Stages three buttons under the summary. `value` on every button carries
// the draft id and thread ts so inbox-interactions.js's click handler never
// has to guess which draft or thread a click belongs to.
export function buildCalendarApprovalBlocks({ draft, threadTs }) {
  const value = JSON.stringify({ draftId: draft.id, threadTs });
  return [
    ...buildMarkdownSectionBlocks(formatCalendarSummary(draft)),
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: applyButtonLabel(draft.action), emoji: true },
          action_id: CALENDAR_ACTIONS.APPLY,
          style: 'primary',
          value,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '✏️ Edit', emoji: true },
          action_id: CALENDAR_ACTIONS.EDIT,
          value,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '🗑️ Discard', emoji: true },
          action_id: CALENDAR_ACTIONS.DISCARD,
          value,
        },
      ],
    },
  ];
}

// Composes the replacement text for a message whose buttons have just been
// used. Conversation history is rebuilt by re-reading the Slack thread (see
// runAgent in pages/api/inbox-assistant.js), so overwriting the original
// summary would erase the event details from the model's own view of what
// it staged -- the same lesson lib/comply-blocks.js's formatResolvedMessage
// encodes for the Comply bot (commit 7e170d2, #26).
export function formatResolvedMessage(originalText, outcome, fallback = outcome) {
  const kept = (originalText || '').trim();
  return kept ? `${kept}\n\n${outcome}` : fallback;
}
