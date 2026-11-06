// Turns the triage model's reply into what is actually posted.
//
// The model sorts the mail and writes the one-line summaries; THIS code owns
// the rules that must hold every day, because a prompt alone can't promise them:
//
//   * the main post is the dated title and 🔴 Action Required, nothing else:
//     no Watching, FYI or Still open sections, no count line, no footnotes
//   * mail that must always appear (the hard floors: money, legal, government,
//     insurance, and the named people) is never dropped -- when it is not in
//     Action Required it goes in a short thread reply under the main post
//   * a must-show email the model left out is added back there, not lost
//   * no title the model invented, no 🔧 System Alerts / ⚪ Low Priority section
//
// The model still sorts everything into Action Required / Watching / FYI and puts
// each email's own [#N] on every line: that is how a line is tied back to an
// email here, and what the auto-filer reads to leave surfaced mail in the inbox.
// Only Action Required keeps its numbers (and gets buttons) in the post.

import { lineCorroborates } from './inbox-blocks.js';
import { TIME_ZONE } from './schedule.js';

// Header of the thread reply that carries the must-show mail.
export const THREAD_HEADER = '*🔒 Always shown* _(money, legal, government, insurance, key people)_';

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

/**
 * @param {string}   modelText    the triage model's reply
 * @param {object[]} candidates   the emails the model was shown, in order: email i is [#i+1]
 * @param {Map<number,string>} floorReasons  [#N] -> why that email must appear
 * @returns {{ text: string, thread: string, surfacedText: string, empty: boolean, stats: object }}
 *   text: the main post (title + Action Required); thread: the reply that carries
 *   the must-show mail that is not in Action Required ('' when there is none).
 */
export function finalizeDigest({ modelText, candidates = [], floorReasons = new Map(), now = new Date() }) {
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
  function buildEntries(lines, { owner = false } = {}) {
    const entries = [];
    for (const entry of splitEntries(lines)) {
      const numbers = numbersOf(entry.lines, items);
      if (numbers.length > 0 && numbers.every((n) => seen.has(n))) continue;
      numbers.forEach((n) => seen.add(n));
      entries.push({ ...entry, numbers, owner, isFloor: numbers.some((n) => floorReasons.has(n)) });
    }
    return entries;
  }
  const watching = buildEntries(sections.watching, { owner: true });
  const fyi = buildEntries(sections.fyi);

  // Hard floors: anything that must appear but doesn't (the model discarded it,
  // or filed it under a section that isn't shown) goes back in.
  const backfilled = [];
  for (const n of floorReasons.keys()) {
    if (seen.has(n) || !candidates[n - 1]) continue;
    backfilled.push({ lines: [backfillLine(candidates[n - 1])], numbers: [n], owner: false, isFloor: true });
    seen.add(n);
  }

  // Everything the triage surfaced -- the thread reply's must-show mail
  // (including what was added back), and the Watching / FYI items that are no
  // longer posted -- so the auto-filer never moves an email the digest showed,
  // or that the model judged worth knowing about.
  const surfacedText = [
    ...actionLines,
    ...watching.flatMap((e) => e.lines),
    ...fyi.flatMap((e) => e.lines),
    ...backfilled.flatMap((e) => e.lines),
  ].join('\n');

  // The thread reply: every must-show email that is not already in Action
  // Required, in the model's order (what it called Watching first, then FYI,
  // then anything it left out). No cap -- a floor is a promise.
  const threadEntries = [...watching, ...fyi, ...backfilled].filter((e) => e.isFloor);
  const threadLines = threadEntries.flatMap((entry) => {
    const out = entry.lines.map(withoutNumbers);
    // A Watching item names who the ask is addressed to.
    if (entry.owner && !/\(\s*owner\s*:/i.test(out[0])) out[0] = `${out[0]} (owner: unclear)`;
    return out;
  });

  const parts = [digestTitle(now)];
  if (actionLines.length) parts.push('', '*🔴 Action Required*', ...actionLines);
  const empty = actionLines.length === 0;
  if (empty) parts.push('', 'Nothing needs your action today. ✅');

  return {
    text: parts.join('\n'),
    thread: threadLines.length ? [THREAD_HEADER, ...threadLines].join('\n') : '',
    surfacedText,
    empty,
    stats: {
      action: splitEntries(actionLines).length,
      floor_shown: threadEntries.length,
      floor_backfilled: backfilled.length,
      hidden_watching: watching.filter((e) => !e.isFloor).length,
      hidden_fyi: fyi.filter((e) => !e.isFloor).length,
    },
  };
}
