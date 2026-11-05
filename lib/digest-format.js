// Turns the triage model's reply into the digest that is actually posted.
//
// The model sorts the mail and writes the one-line summaries; THIS code owns
// the rules that must hold every day, because a prompt alone can't promise them:
//
//   * the buckets, in order: 🔴 Action Required, 👀 Watching, 🟡 FYI
//   * 👀 Watching and 🟡 FYI are each capped at 5 items, with the hard-floor
//     items ranked in first, and one "…and N more, not listed" line for the rest
//   * a hard-floor item the model left out is added back (as FYI) -- never
//     silently dropped
//   * no title the model invented, no 🔧 System Alerts / ⚪ Low Priority section,
//     no "N emails total" closing line, no count footnotes
//
// The model puts each email's own [#N] on every line in every bucket, which is
// how a line is tied back to an email here. The numbers are then removed from
// Watching and FYI lines: only Action Required items are numbered in the post
// (and only those get buttons).

import { lineCorroborates } from './inbox-blocks.js';
import { TIME_ZONE } from './schedule.js';

export const MAX_BUCKET_ITEMS = 5;

export const HEADERS = {
  action: '*🔴 Action Required*',
  watching: '*👀 Watching*',
  fyi: '*🟡 FYI / Needs Awareness*',
};

const SECTION_MATCHERS = [
  ['action', /^\*\s*(?:🔴|action required)/i],
  ['watching', /^\*\s*(?:👀|watching)/i],
  ['fyi', /^\*\s*(?:🟡|fyi)/i],
  ['alerts', /^\*\s*(?:🔧|system alerts)/i], // retired: dropped
  ['noise', /^\*\s*(?:⚪|low priority)/i], // never shown: dropped
];

export function digestTitle(now = new Date()) {
  const label = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, weekday: 'long', month: 'long', day: 'numeric',
  }).format(now);
  return `*🌅 Morning Digest — ${label}*`;
}

function sectionKeyOf(line) {
  const trimmed = line.trim();
  if (!/^\*[^*]+\*$/.test(trimmed)) return null;
  return SECTION_MATCHERS.find(([, pattern]) => pattern.test(trimmed))?.[0] || null;
}

// The closing "N emails total — X need action" line and the old count
// footnotes (spam archived/filtered, filed, drafts) are not part of the digest,
// even if the model writes one anyway.
function isFootnoteLine(line) {
  return /\b\d+\s+emails?\s+total\b/i.test(line)
    || /^\s*_?\s*(?:🗑️?|🧹|🗂️?|📝)/u.test(line);
}

function parseSections(text) {
  const sections = { action: [], watching: [], fyi: [], alerts: [], noise: [] };
  let current = null; // lines before the first bucket (the model's own title) are dropped
  for (const raw of (text || '').split('\n')) {
    const key = sectionKeyOf(raw);
    if (key) {
      current = key;
      continue;
    }
    if (!current || isFootnoteLine(raw)) continue;
    sections[current].push(raw.replace(/\s+$/, ''));
  }
  return sections;
}

// One entry = one top-level line plus any indented / ↳ lines under it (a
// grouped block counts as one entry).
function splitEntries(lines) {
  const entries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const continuation = /^\s/.test(line) && entries.length > 0;
    if (continuation) entries[entries.length - 1].lines.push(line);
    else entries.push({ lines: [line] });
  }
  return entries;
}

const NUMBER_PATTERN = /\[#(\d+)\]/g;

// The email numbers an entry really refers to: each [#N] counts only if its own
// line also names that email (sender, address, or a subject fragment), so a
// mis-numbered line can't make a different email look "shown".
function numbersOf(lines, items) {
  const numbers = [];
  for (const line of lines) {
    for (const match of line.matchAll(NUMBER_PATTERN)) {
      const n = Number(match[1]);
      const item = items.get(n);
      if (item && lineCorroborates(line, item) && !numbers.includes(n)) numbers.push(n);
    }
  }
  return numbers;
}

function withoutNumbers(line) {
  return line.replace(/\[#\d+\]\s*/g, '');
}

function oneLine(text, max) {
  const flat = (text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

// A plain line for a must-show email the model left out.
function backfillLine(email) {
  const sender = email.from?.emailAddress?.name || email.from?.emailAddress?.address || 'Unknown sender';
  const subject = oneLine(email.subject || '(no subject)', 90);
  const preview = oneLine(email.bodyPreview, 110);
  return `- ${sender} — ${subject}${preview ? `: ${preview}` : ''}`;
}

// Floors first (they are guaranteed a place), then the model's own order; the
// cap fills what's left. If there are more than `max` floor items they ALL
// show -- a floor is a promise -- and the cap simply leaves no room for others.
function capEntries(entries, max) {
  const floors = entries.filter((e) => e.isFloor);
  const rest = entries.filter((e) => !e.isFloor);
  const room = Math.max(0, max - floors.length);
  return { shown: [...floors, ...rest.slice(0, room)], more: Math.max(0, rest.length - room) };
}

/**
 * @param {string}   modelText    the triage model's reply
 * @param {object[]} candidates   the emails the model was shown, in order: email i is [#i+1]
 * @param {Map<number,string>} floorReasons  [#N] -> why that email must appear
 */
export function finalizeDigest({ modelText, candidates = [], floorReasons = new Map(), now = new Date(), maxPerBucket = MAX_BUCKET_ITEMS }) {
  const items = new Map(candidates.map((email, i) => [i + 1, {
    sender_name: email.from?.emailAddress?.name,
    sender_email: email.from?.emailAddress?.address,
    subject: email.subject,
  }]));
  const sections = parseSections(modelText);

  const actionLines = [...sections.action];
  while (actionLines.length && !actionLines[actionLines.length - 1].trim()) actionLines.pop();
  while (actionLines.length && !actionLines[0].trim()) actionLines.shift();
  const actionNumbers = numbersOf(actionLines, items);

  // An email shown in a higher bucket is not repeated in a lower one.
  const seen = new Set(actionNumbers);
  function buildEntries(lines) {
    const entries = [];
    for (const entry of splitEntries(lines)) {
      const numbers = numbersOf(entry.lines, items);
      if (numbers.length > 0 && numbers.every((n) => seen.has(n))) continue;
      numbers.forEach((n) => seen.add(n));
      entries.push({ ...entry, numbers, isFloor: numbers.some((n) => floorReasons.has(n)) });
    }
    return entries;
  }
  const watching = buildEntries(sections.watching);
  const fyi = buildEntries(sections.fyi);

  // Hard floors: anything that must appear but doesn't (the model discarded it,
  // or filed it under a section that isn't shown) goes back in as FYI.
  let backfilled = 0;
  for (const n of floorReasons.keys()) {
    if (seen.has(n) || !candidates[n - 1]) continue;
    fyi.push({ lines: [`${backfillLine(candidates[n - 1])}`], numbers: [n], isFloor: true });
    seen.add(n);
    backfilled += 1;
  }

  // Everything the triage surfaced -- including what the cap hides -- so the
  // auto-filer never moves an email the digest was about to mention.
  const surfacedText = [...actionLines, ...watching.flatMap((e) => e.lines), ...fyi.flatMap((e) => e.lines)].join('\n');

  const cappedWatching = capEntries(watching, maxPerBucket);
  const cappedFyi = capEntries(fyi, maxPerBucket);

  const bucketLines = (entries, more, { owner = false } = {}) => {
    const lines = entries.flatMap((entry) => {
      const out = entry.lines.map(withoutNumbers);
      // Every Watching line names who the ask is addressed to.
      if (owner && !/\(\s*owner\s*:/i.test(out[0])) out[0] = `${out[0]} (owner: unclear)`;
      return out;
    });
    if (more > 0) lines.push(`_…and ${more} more, not listed_`);
    return lines;
  };

  const parts = [digestTitle(now)];
  if (actionLines.length) parts.push('', HEADERS.action, ...actionLines);
  if (cappedWatching.shown.length) parts.push('', HEADERS.watching, ...bucketLines(cappedWatching.shown, cappedWatching.more, { owner: true }));
  if (cappedFyi.shown.length) parts.push('', HEADERS.fyi, ...bucketLines(cappedFyi.shown, cappedFyi.more));
  const empty = parts.length === 1;
  if (empty) parts.push('', 'Nothing new needs your attention. ✅');

  return {
    text: parts.join('\n'),
    surfacedText,
    empty,
    stats: {
      action: splitEntries(actionLines).length,
      watching_shown: cappedWatching.shown.length,
      watching_more: cappedWatching.more,
      fyi_shown: cappedFyi.shown.length,
      fyi_more: cappedFyi.more,
      floor_backfilled: backfilled,
    },
  };
}
