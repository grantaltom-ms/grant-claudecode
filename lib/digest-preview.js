// The read-only "preview" of the morning digest (GET/POST /api/digest?preview=1).
//
// A preview runs the whole digest on real mail but changes nothing: nothing is
// posted to Slack, saved, filed, archived or deleted, the to-do list and the
// next digest's lookback are untouched. It hands the result back to whoever
// asked instead. This turns that result into plain text that reads well in a
// terminal.

const RULE = '═'.repeat(4);

export function formatPreview(result) {
  const { lookback = {}, fetched = 0, main = '', thread = '', buttons = [], counts = {}, truncated = false, fetchCap } = result;
  const hours = Number.isFinite(lookback.hours) ? lookback.hours.toFixed(1) : '?';
  const lines = [];

  lines.push('PREVIEW ONLY — nothing was posted, saved, filed, archived or changed.');
  lines.push(
    `Looked back ${hours} hours (a preview always looks back at least a day), read ${fetched} email${fetched === 1 ? '' : 's'}`
    + (truncated ? ` — stopped at the ${fetchCap}-email limit, older mail in that window was not read` : '')
    + '.'
  );
  lines.push('');
  lines.push(`${RULE} MAIN POST (what #inbox-digest would show) ${RULE}`);
  lines.push(main || '(nothing)');
  lines.push('');
  lines.push(buttons.length
    ? 'Buttons that would appear (✍️ Reply / ✅ Done / 💤 Tomorrow):'
    : 'Buttons that would appear: none');
  for (const button of buttons) lines.push(`  ${button}`);
  lines.push('');
  lines.push(`${RULE} REPLY UNDER IT (only posted when there is must-show mail) ${RULE}`);
  lines.push(thread || '(none: no must-show mail in this window)');
  lines.push('');
  lines.push(`${RULE} LEFT OUT, FOR YOUR INFORMATION (never posted) ${RULE}`);
  lines.push(`Work-order mail dropped: ${counts.work_orders_dropped ?? 0}`);
  lines.push(`Threads you already replied to, dropped: ${counts.replied_dropped ?? 0}`);
  lines.push(`Spam filtered: ${counts.spam_filtered ?? 0}`);
  lines.push(`Watching / FYI mail not shown (not must-show): ${(counts.hidden_watching ?? 0) + (counts.hidden_fyi ?? 0)}`);
  if (counts.triage_failed) lines.push('⚠️ The triage model returned no text, so a real run would have posted an error instead.');
  lines.push('');
  lines.push('Not simulated in a preview: auto-filing into "Filed by Bot", and the to-do list sweep.');
  return lines.join('\n');
}
