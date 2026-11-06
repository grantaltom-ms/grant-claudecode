import { describe, it, expect } from 'vitest';
import { finalizeDigest, digestTitle, THREAD_HEADER } from '../../lib/digest-format';

const NOW = new Date('2026-11-05T15:30:00Z'); // Thursday, Nov 5, 7:30 AM Pacific

function mail(i, name, address, subject, preview = 'Preview text.') {
  return { id: `m${i}`, subject, bodyPreview: preview, from: { emailAddress: { name, address } } };
}

// Email i (1-based) is [#i]. People are distinct so a line can only corroborate its own email.
const PEOPLE = [
  ['Alice Anders', 'alice@a.example', 'Roof quote'],
  ['Bob Baker', 'bob@b.example', 'Gutter cleaning'],
  ['Carol Chen', 'carol@c.example', 'Lease renewal'],
  ['Dan Diaz', 'dan@d.example', 'Boiler inspection'],
  ['Erin Ellis', 'erin@e.example', 'Parking signs'],
  ['Fay Fong', 'fay@f.example', 'Move-out walkthrough'],
  ['Gus Gray', 'gus@g.example', 'Landscaping schedule'],
  ['Hana Hill', 'hana@h.example', 'Window screens'],
  ['Ian Ito', 'ian@i.example', 'Elevator service'],
  ['Jo Jain', 'jo@j.example', 'Mailbox keys'],
];
const candidates = PEOPLE.map(([name, address, subject], i) => mail(i + 1, name, address, subject));
const line = (n, extra = '') => `- [#${n}] ${PEOPLE[n - 1][0]} — ${PEOPLE[n - 1][2]}: summary${extra}`;

function run(modelText, floorReasons = new Map()) {
  return finalizeDigest({ modelText, candidates, floorReasons, now: NOW });
}

describe('the main post is the title and Action Required, nothing else', () => {
  it('writes its own dated title and ignores the model\'s', () => {
    expect(digestTitle(NOW)).toBe('*🌅 Morning Digest — Thursday, November 5*');
    const { text } = run(`*🌅 Morning Digest — Made Up Day*\n\n*🔴 Action Required*\n${line(1)}`);
    expect(text.startsWith('*🌅 Morning Digest — Thursday, November 5*')).toBe(true);
    expect(text).not.toContain('Made Up Day');
  });

  it('shows Action Required only: Watching and FYI items never appear in it', () => {
    const { text, thread, stats } = run(
      `*🔴 Action Required*\n${line(1)}\n\n*👀 Watching*\n${line(2, ' (owner: Kelsey)')}\n\n*🟡 FYI / Needs Awareness*\n${line(3)}\n${line(4)}`
    );
    expect(text).toBe(`*🌅 Morning Digest — Thursday, November 5*\n\n*🔴 Action Required*\n${line(1)}`);
    expect(text).not.toMatch(/Watching|FYI|Still open|Gutter|Lease|Boiler/);
    expect(thread).toBe('');
    expect(stats).toMatchObject({ action: 1, hidden_watching: 1, hidden_fyi: 2 });
  });

  it('says so plainly when nothing needs action', () => {
    const none = run('*🌅 Morning Digest*\n');
    expect(none.empty).toBe(true);
    expect(none.text).toContain('Nothing needs your action today');
    const onlyFyi = run(`*🟡 FYI / Needs Awareness*\n${line(3)}`);
    expect(onlyFyi.empty).toBe(true);
    expect(onlyFyi.text).not.toContain('Lease renewal');
  });

  it('is uncapped, keeps its [#N] numbers and grouped blocks', () => {
    const lines = candidates.map((_, i) => line(i + 1)).join('\n');
    const { text } = run(`*🔴 Action Required*\n${lines}`);
    for (let n = 1; n <= 10; n += 1) expect(text).toContain(`[#${n}]`);

    const grouped = run(`*🔴 Action Required*\n*Roof & gutters*\n  ↳ [#1] Alice Anders — Roof quote: x\n  ↳ [#2] Bob Baker — Gutter cleaning: y`);
    expect(grouped.text).toContain('*Roof & gutters*');
    expect(grouped.text).toContain('↳ [#2] Bob Baker');
  });

  it('strips the "N emails total" line and any count footnotes the model adds', () => {
    const { text, thread } = run(
      `*🔴 Action Required*\n${line(1)}\n\n*🟡 FYI / Needs Awareness*\n${line(3)}\n\n` +
      `*14 emails total — 2 need action*\n_🗑️ 3 spam emails auto-archived_\n_🧹 2 suspected spam filtered_\n_📝 2 reply drafts waiting_\n_🗂 Filed 4 emails_`
    );
    expect(text).not.toMatch(/emails total|need action|spam|drafts|Filed/i);
    expect(thread).toBe('');
    expect(text.trim().endsWith('summary')).toBe(true);
  });

  it('drops a System Alerts or Low Priority section the model still writes', () => {
    const { text, thread } = run(
      `*🔧 System Alerts*\n- Zapier — delinquency-outreach failed\n\n*🔴 Action Required*\n${line(1)}\n\n*⚪ Low Priority / Noise*\n- AppFolio — report ran`
    );
    expect(text).not.toMatch(/System Alerts|Zapier|Low Priority|AppFolio — report/);
    expect(thread).toBe('');
    expect(text).toContain('Roof quote');
  });
});

describe('hard floors go in a thread reply', () => {
  it('puts a must-show email the model called FYI or Watching in the thread, numbers off', () => {
    const floors = new Map([[3, 'money mail'], [2, 'priority sender: Rhoda Altom']]);
    const { text, thread, stats } = run(
      `*🔴 Action Required*\n${line(1)}\n\n*👀 Watching*\n${line(2, ' (owner: Kelsey Dempsey)')}\n\n*🟡 FYI / Needs Awareness*\n${line(3)}\n${line(4)}`,
      floors
    );
    expect(text).not.toMatch(/Gutter|Lease/); // not in the main post
    expect(thread.split('\n')[0]).toBe(THREAD_HEADER);
    expect(thread).toContain('- Bob Baker — Gutter cleaning: summary (owner: Kelsey Dempsey)');
    expect(thread).toContain('- Carol Chen — Lease renewal: summary');
    expect(thread).not.toMatch(/\[#\d+\]/);
    expect(thread).not.toContain('Boiler inspection'); // #4 is FYI but not a floor: nowhere
    expect(stats).toMatchObject({ floor_shown: 2, floor_backfilled: 0, hidden_fyi: 1 });
  });

  it('puts a must-show email the model discarded back in, in the thread', () => {
    const floors = new Map([[4, 'priority sender: Rhoda Altom'], [6, 'money mail']]);
    const { text, thread, stats } = run(`*🔴 Action Required*\n${line(1)}`, floors);
    expect(text).not.toMatch(/Boiler|Move-out/);
    expect(thread).toContain('- Dan Diaz — Boiler inspection: Preview text.');
    expect(thread).toContain('- Fay Fong — Move-out walkthrough: Preview text.');
    expect(stats.floor_backfilled).toBe(2);
  });

  it('puts it back even if the model filed it under a section that is not shown', () => {
    const { thread } = run(`*🔧 System Alerts*\n${line(4)}\n\n*⚪ Low Priority / Noise*\n${line(6)}`, new Map([[4, 'x'], [6, 'y']]));
    expect(thread).toContain('Dan Diaz');
    expect(thread).toContain('Fay Fong');
  });

  it('works when nothing needs action: the main post says so and the thread carries the mail', () => {
    const { text, thread, empty } = run('Nothing else to report.', new Map([[1, 'money mail']]));
    expect(empty).toBe(true);
    expect(text).toContain('Nothing needs your action today');
    expect(thread).toContain('Alice Anders — Roof quote');
  });

  it('does not repeat a must-show email that is already in Action Required', () => {
    const floors = new Map([[1, 'a'], [2, 'b']]);
    const { text, thread, stats } = run(`*🔴 Action Required*\n${line(1)}\n\n*🟡 FYI / Needs Awareness*\n${line(1)}\n${line(2)}`, floors);
    expect(text).toContain('Roof quote');
    expect(thread).not.toContain('Roof quote');
    expect(thread).toContain('Gutter cleaning');
    expect(stats.floor_shown).toBe(1);
  });

  it('a wrong [#N] cannot make a different email look "shown"', () => {
    // The line says [#4] but describes Alice (#1). Dan (#4) is a floor item and was NOT shown.
    const { thread } = run(`*🟡 FYI / Needs Awareness*\n- [#4] Alice Anders — Roof quote: x`, new Map([[4, 'x']]));
    expect(thread).toContain('Dan Diaz — Boiler inspection');
  });

  it('shows every must-show email: there is no cap', () => {
    const fyi = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => line(n)).join('\n');
    const floors = new Map([1, 2, 3, 4, 5, 6, 7].map((n) => [n, 'money mail']));
    const { thread } = run(`*🟡 FYI / Needs Awareness*\n${fyi}`, floors);
    expect([...thread.matchAll(/^- /gm)]).toHaveLength(7);
    expect(thread).not.toContain('Window screens'); // #8 is not a floor
    expect(thread).not.toMatch(/more, not listed/);
  });

  it('every Watching line in the thread names an owner (flagged as unclear if the model forgot)', () => {
    const { thread } = run(`*👀 Watching*\n${line(2, ' (owner: Kelsey Dempsey)')}\n${line(3)}`, new Map([[2, 'x'], [3, 'y']]));
    expect(thread).toContain('(owner: Kelsey Dempsey)');
    expect(thread).toContain('Carol Chen — Lease renewal: summary (owner: unclear)');
  });

  it('lists what the model called Watching first, then FYI, then anything it left out', () => {
    const floors = new Map([[8, 'x'], [5, 'y'], [3, 'z']]);
    const { thread } = run(`*🟡 FYI / Needs Awareness*\n${line(5)}\n\n*👀 Watching*\n${line(3, ' (owner: x)')}`, floors);
    const order = [...thread.matchAll(/^- (\w+) /gm)].map((m) => m[1]);
    expect(order).toEqual(['Carol', 'Erin', 'Hana']);
  });
});

describe('what the auto-filer is told was surfaced', () => {
  it('includes must-show mail the model left out and the code added to the thread reply', () => {
    // Without this the filer would treat the email as unseen noise and move it out of the inbox.
    const { thread, surfacedText } = run('Nothing else to report.', new Map([[4, 'priority sender: Rhoda Altom']]));
    expect(thread).toContain('Dan Diaz — Boiler inspection');
    expect(surfacedText).toContain('Dan Diaz');
    expect(surfacedText).toContain('Boiler inspection');
  });

  it('includes the Watching and FYI items that are no longer posted, so they are never filed away unseen', () => {
    const { text, thread, surfacedText } = run(
      `*🔴 Action Required*\n${line(1)}\n\n*👀 Watching*\n${line(2, ' (owner: x)')}\n\n*🟡 FYI / Needs Awareness*\n${line(7)}`
    );
    expect(text + thread).not.toContain('Gus Gray');
    expect(surfacedText).toContain('Gus Gray');
    expect(surfacedText).toContain('Bob Baker');
    expect(surfacedText).toContain('Alice Anders');
  });
});
