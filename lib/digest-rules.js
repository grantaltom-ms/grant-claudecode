// Fixed rules for the morning inbox digest, kept apart from the triage model so
// they behave the same every day: how far back to look, which mail is dropped
// outright, and which mail must always be shown. Everything here is pure.

import { normalizeEmail } from './correspondent-history.js';

// ─── Lookback window ────────────────────────────────────────────────────────
//
// The digest covers "since the end of the last successful digest run": about
// 24h on a normal weekday, about 72h on Monday (so the weekend is covered),
// longer after a missed day -- but never more than 96h. With nothing stored to
// go on it falls back to 24h.

export const DEFAULT_WINDOW_HOURS = 24;
export const MAX_WINDOW_HOURS = 96;

const HOUR_MS = 3_600_000;

export function resolveWindow(lastCoverageEnd, now = new Date(), { force = false } = {}) {
  const last = lastCoverageEnd ? Date.parse(lastCoverageEnd) : NaN;
  // A stored time in the future (clock trouble) can't be trusted: use the default.
  const usable = Number.isFinite(last) && last <= now.getTime();
  let hours = usable ? (now.getTime() - last) / HOUR_MS : DEFAULT_WINDOW_HOURS;
  let source = usable ? 'since_last_digest' : 'default_24h';

  // A manual ?force=1 re-run right after a normal run would otherwise cover
  // only the last few minutes and come back "nothing new". Never look back
  // less than a day when forced -- the same reach the digest always had.
  if (force && hours < DEFAULT_WINDOW_HOURS) {
    hours = DEFAULT_WINDOW_HOURS;
    source = 'forced_minimum_24h';
  }

  const cappedAtMax = hours > MAX_WINDOW_HOURS;
  hours = Math.min(hours, MAX_WINDOW_HOURS);
  return {
    since: new Date(now.getTime() - hours * HOUR_MS).toISOString(),
    hours,
    source,
    cappedAtMax,
  };
}

// How many messages one run will pull: ~40 per 24h of window, never below the
// 50 the digest has always pulled, never above 150. (A Monday run, ~72h, gets
// 120 instead of being cut off at the old 50.)
export const FETCH_CAP_PER_24H = 40;
export const MIN_FETCH_CAP = 50;
export const MAX_FETCH_CAP = 150;

export function fetchCapForWindow(hours) {
  // Rounded, not ceiled: a window that is a few seconds over 72h is still a 72h window.
  const scaled = Math.round((FETCH_CAP_PER_24H * hours) / 24);
  return Math.min(MAX_FETCH_CAP, Math.max(MIN_FETCH_CAP, scaled));
}

// ─── Work orders ────────────────────────────────────────────────────────────
//
// ALL work-order mail is dropped before triage -- notifications, requests,
// updates, completions, from any sender or system (AppFolio included). It is
// never shown in any bucket and never reaches the triage model.

const WORK_ORDER = /\bwork[\s_-]?orders?\b/i;

export function isWorkOrderMail(email) {
  const sender = email.from?.emailAddress?.name || '';
  return WORK_ORDER.test(`${email.subject || ''}\n${email.bodyPreview || ''}\n${sender}`);
}

// ─── Hard floors ────────────────────────────────────────────────────────────
//
// Some mail must always appear in the digest -- at least as FYI -- whatever the
// triage model thinks of it:
//   (a) mail about money, legal, government, or insurance
//   (b) mail from a short list of people, matched by sender EMAIL ADDRESS
// A floor guarantees the item appears; which bucket it lands in still follows
// the addressee rule, the work-order drop and the already-replied drop.

// People are matched on the address, never the display name: Caitlin Sogn at
// College Club must not match Caitlin Brisson. Addresses come from here plus
// the DIGEST_PRIORITY_SENDERS env var (JSON, same shape), which is where the
// ones not known to the repo are added without a code change:
//   DIGEST_PRIORITY_SENDERS=[{"name":"Caitlin Brisson","emails":["..."]}]
export const DEFAULT_PRIORITY_SENDERS = [
  { name: 'Rhoda Altom', emails: ['rhoda@milestoneproperties.net'] },
  { name: 'Conor Murphy', emails: ['accounting@milestoneproperties.net'] },
  { name: 'Caitlin Brisson', emails: [] },
  { name: 'Helmut Hummes', emails: [] },
];

export function resolvePrioritySenders(env = process.env) {
  const people = DEFAULT_PRIORITY_SENDERS.map((p) => ({ name: p.name, emails: new Set(p.emails.map(normalizeEmail)) }));
  const raw = env.DIGEST_PRIORITY_SENDERS;
  if (raw) {
    try {
      const extra = JSON.parse(raw);
      if (!Array.isArray(extra)) throw new Error('expected a JSON array');
      for (const entry of extra) {
        if (!entry?.name) continue;
        let person = people.find((p) => p.name.toLowerCase() === String(entry.name).toLowerCase());
        if (!person) {
          person = { name: String(entry.name), emails: new Set() };
          people.push(person);
        }
        for (const address of entry.emails || []) {
          if (normalizeEmail(address)) person.emails.add(normalizeEmail(address));
        }
      }
    } catch (err) {
      console.error('DIGEST_PRIORITY_SENDERS is not valid JSON; using the built-in list only', err.message);
    }
  }
  return people;
}

// Priority people with no email address on file. The floor can't see them, so
// the digest logs this loudly every run until an address is added.
export function sendersMissingAddresses(people) {
  return people.filter((p) => p.emails.size === 0).map((p) => p.name);
}

export function prioritySenderFor(email, people) {
  const address = normalizeEmail(email.from?.emailAddress?.address);
  if (!address) return null;
  return people.find((p) => p.emails.has(address))?.name || null;
}

// Keyword backstop for "money, legal, government, insurance". Deliberately
// aimed at things that ask something of Grant or put something at stake --
// routine receipts ("payment received") are NOT floored, or every tenant
// payment notice would crowd the FYI list. The triage model is told the wider
// rule; this is the part that can't be talked out of it.
const FLOOR_TOPICS = [
  ['money', /\b(invoices?|billing|bills|past[ -]due|overdue|balance due|amount due|payment (?:due|failed|declined|required|request(?:ed)?|reminder|instructions|past due|overdue)|wire (?:transfer|instructions|details)|wiring instructions|ach|bank(?:ing)? (?:details|account)|account number|routing number|loans?|mortgage|refinanc\w*|escrow|1099|w-?9|taxes|tax|refunds?|owed)\b/i],
  ['legal', /\b(legal|attorneys?|lawyers?|counsel|court|motion|lawsuit|litigation|subpoena|summons|eviction|lien|cease and desist|demand letter|notice to (?:vacate|terminate|quit|comply))\b/i],
  ['government', /\b(irs|department of|dept\.? of|city of|king county|county|state of washington|washington state|l&i|sdci|hud|notice of violation|code enforcement|permits?|public records|assessor|secretary of state)\b/i],
  ['insurance', /\b(insurance|insurer|(?<!privacy\s)(?<!cookie\s)(?<!return\s)polic(?:y|ies)|premium|claims?|coverage|deductible|certificate of insurance|adjuster|loss run)\b/i],
];

export function floorTopic(email) {
  const text = `${email.subject || ''}\n${email.bodyPreview || ''}`;
  for (const [topic, pattern] of FLOOR_TOPICS) {
    if (pattern.test(text)) return topic;
  }
  const domain = normalizeEmail(email.from?.emailAddress?.address).split('@')[1] || '';
  if (/(^|\.)gov$/.test(domain)) return 'government';
  return null;
}

// Why this email must appear, or null if it has no floor.
export function floorReason(email, people) {
  const person = prioritySenderFor(email, people);
  if (person) return `priority sender: ${person}`;
  const topic = floorTopic(email);
  return topic ? `${topic} mail` : null;
}

// ─── Addressees ─────────────────────────────────────────────────────────────

function recipientLabel(recipient) {
  const address = recipient?.emailAddress?.address || '';
  const name = (recipient?.emailAddress?.name || '').replace(/\s+/g, ' ').trim();
  if (!address) return name;
  return name && name.toLowerCase() !== address.toLowerCase() ? `${name} <${address}>` : address;
}

// "Name <a@x>, Name <b@x>, +3 more" -- bounded so one reply-all to a long
// distribution list can't swamp the triage prompt.
export function formatRecipients(recipients, max = 8) {
  const labels = (recipients || []).map(recipientLabel).filter(Boolean);
  if (labels.length === 0) return '(none)';
  const shown = labels.slice(0, max).join(', ');
  return labels.length > max ? `${shown}, +${labels.length - max} more` : shown;
}

function addressesOf(recipients) {
  return (recipients || []).map((r) => normalizeEmail(r?.emailAddress?.address)).filter(Boolean);
}

// Is Grant only cc'd? (In Cc, not in To.) A message that reaches him some other
// way -- Bcc, a distribution list -- has neither, and is not flagged.
export function isOwnerCcOnly(email, ownerEmail) {
  const owner = normalizeEmail(ownerEmail);
  return addressesOf(email.ccRecipients).includes(owner) && !addressesOf(email.toRecipients).includes(owner);
}
