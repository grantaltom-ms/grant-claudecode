// The morning digest's triage call: budget, one automatic retry, and batching.
//
// Why this exists (Nov 2026): the lookback is "everything since the last
// successful digest", so a Monday covers ~72h of mail, and a failed run does
// not move coverage forward -- the next window is bigger still, up to the 96h
// cap. With a 4000-token answer budget the model ran out of room mid-reply on
// those big windows (stop_reason "max_tokens", no text), the warning posted
// instead of a digest, and it could never recover on its own. So:
//
//   1. the answer budget is TRIAGE_MAX_TOKENS (12000), on top of the thinking
//      headroom lib/claude.js adds;
//   2. if a reply comes back with no text because it hit max_tokens, the same
//      call is retried once at double the budget before giving up;
//   3. more than BATCH_THRESHOLD candidates are triaged in batches of at most
//      BATCH_SIZE, and the batches' replies are merged into one reply before
//      the usual finalize step (lib/digest-format.js).
//
// Numbering: every email keeps its ONE global number ([#N] = candidates[N-1])
// in every batch -- the batches are slices of the same numbered list, never
// renumbered -- so the merged reply maps to the right emails exactly as a
// single call would. A line citing a number outside its own batch can only be
// a mis-numbering, so it is dropped rather than risk pointing at the wrong mail.

import { responseText as defaultResponseText } from './claude.js';
import { parseSections, splitEntries } from './digest-format.js';

export const TRIAGE_MAX_TOKENS = 12000;
export const TRIAGE_RETRY_MAX_TOKENS = TRIAGE_MAX_TOKENS * 2;
export const BATCH_THRESHOLD = 50;
export const BATCH_SIZE = 40;

const BUCKET_HEADERS = {
  action: '*🔴 Action Required*',
  watching: '*👀 Watching*',
  fyi: '*🟡 FYI / Needs Awareness*',
};

/**
 * Splits 1..count into contiguous batches. Up to BATCH_THRESHOLD emails go in
 * one call; above that, the fewest batches of at most BATCH_SIZE, evened out
 * (51 -> 26 + 25, not 40 + 11).
 * @returns {{ start: number, end: number }[]}  1-based, inclusive
 */
export function planBatches(count, { threshold = BATCH_THRESHOLD, size = BATCH_SIZE } = {}) {
  if (count <= 0) return [];
  if (count <= threshold) return [{ start: 1, end: count }];
  const batches = Math.ceil(count / size);
  const per = Math.ceil(count / batches);
  const out = [];
  for (let start = 1; start <= count; start += per) {
    out.push({ start, end: Math.min(count, start + per - 1) });
  }
  return out;
}

/**
 * One triage call, with a single retry at double the budget when the reply
 * hit max_tokens before writing any text.
 * @returns {Promise<{ text: string, stopReason: string|undefined, retried: boolean }>}
 */
export async function triageOnce({ callClaude, responseText = defaultResponseText, request, label = 'triage', log = console }) {
  const first = await callClaude({ ...request, maxTokens: TRIAGE_MAX_TOKENS });
  const firstText = responseText(first);
  if (firstText || first?.stop_reason !== 'max_tokens') {
    return { text: firstText, stopReason: first?.stop_reason, retried: false };
  }
  log.warn(`Digest ${label} hit max_tokens with no text at ${TRIAGE_MAX_TOKENS}; retrying once at ${TRIAGE_RETRY_MAX_TOKENS}.`);
  const second = await callClaude({ ...request, maxTokens: TRIAGE_RETRY_MAX_TOKENS });
  const secondText = responseText(second);
  log.warn(`Digest ${label} retry ${secondText ? 'succeeded' : 'also returned no text'} (stop reason: ${second?.stop_reason || 'unknown'}).`);
  return { text: secondText, stopReason: second?.stop_reason, retried: true };
}

// Keeps only the lines of one batch's reply that cite emails in that batch
// (or cite none, e.g. a group heading), then re-emits it bucket by bucket.
const hasNumber = (line) => /\[#\d+\]/.test(line);

function batchSections(text, { start, end }) {
  const sections = parseSections(text);
  const inRange = (line) => {
    const numbers = [...line.matchAll(/\[#(\d+)\]/g)].map((m) => Number(m[1]));
    return numbers.length === 0 || numbers.every((n) => n >= start && n <= end);
  };
  const out = {};
  for (const key of Object.keys(BUCKET_HEADERS)) {
    out[key] = splitEntries(sections[key])
      .map((entry) => ({ hadNumbers: entry.lines.some(hasNumber), lines: entry.lines.filter(inRange) }))
      // An entry that cited emails but lost all of them (e.g. a group whose
      // every line was out of range) would leave a bare heading: drop it.
      .filter(({ hadNumbers, lines }) => lines.length > 0 && (!hadNumbers || lines.some(hasNumber)))
      .map(({ lines }) => lines);
  }
  return out;
}

/**
 * Merges batch replies into one reply in the format a single triage call
 * returns: each bucket once, in order, batch by batch.
 * @param {{ text: string, range: { start: number, end: number } }[]} parts
 */
export function mergeTriageReplies(parts) {
  const merged = { action: [], watching: [], fyi: [] };
  for (const { text, range } of parts) {
    const sections = batchSections(text, range);
    for (const key of Object.keys(merged)) merged[key].push(...sections[key].flat());
  }
  const blocks = [];
  for (const [key, header] of Object.entries(BUCKET_HEADERS)) {
    if (merged[key].length) blocks.push([header, ...merged[key]].join('\n'));
  }
  return blocks.join('\n\n');
}

/**
 * Runs the whole triage for a numbered email list.
 * @param {string[]} emailLines   emailLines[i] is the text for email [#i+1]
 * @param {(batchText: string, batch: { index: number, total: number }) => object} buildRequest
 *   returns the callClaude request (system, messages, timeoutMs...) for one batch
 * @returns {Promise<{ text: string, failed: boolean, stopReason: string|undefined, batches: number, retries: number }>}
 *   failed: some batch produced no text even after its retry -- the run must
 *   then post the warning and NOT advance coverage.
 */
export async function runTriage({ callClaude, responseText, emailLines, buildRequest, log = console }) {
  const plan = planBatches(emailLines.length);
  if (plan.length > 1) {
    log.log(`Digest triage: ${emailLines.length} candidates, splitting into ${plan.length} batches (${plan.map((b) => `${b.start}-${b.end}`).join(', ')}).`);
  }
  const results = await Promise.all(plan.map((range, index) => triageOnce({
    callClaude,
    responseText,
    log,
    label: plan.length > 1 ? `triage batch ${index + 1}/${plan.length}` : 'triage',
    request: buildRequest(emailLines.slice(range.start - 1, range.end).join('\n'), { index, total: plan.length }),
  })));
  const retries = results.filter((r) => r.retried).length;
  const failedResult = results.find((r) => !r.text);
  if (failedResult) {
    return { text: '', failed: true, stopReason: failedResult.stopReason, batches: plan.length, retries };
  }
  const text = plan.length === 1
    ? results[0].text
    : mergeTriageReplies(results.map((r, i) => ({ text: r.text, range: plan[i] })));
  return { text, failed: false, stopReason: results[results.length - 1].stopReason, batches: plan.length, retries };
}
