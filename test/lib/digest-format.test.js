import { describe, it, expect } from 'vitest';
import { finalizeDigest, digestTitle, MAX_BUCKET_ITEMS } from '../../lib/digest-format';

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

function run(modelText, floorReasons = new Map(), opts = {}) {
  return finalizeDigest({ modelText, candidates, floorReasons, now: NOW, ...opts });
}

describe('digest title and bucket order', () => {
  it('writes its own dated title and ignores the model\'s', () => {
    expect(digestTitle(NOW)).toBe('*🌅 Morning Digest — Thursday, November 5*');
    const { text } = run(`*🌅 Morning Digest — Made Up Day*\n\n*🔴 Action Required*\n${line(1)}`);
    expect(text.startsWith('*🌅 Morning Digest — Thursday, November 5*')).toBe(true);
    expect(text).not.toContain('Made Up Day');
  });

  it('renders 🔴 Action Required, then 👀 Watching, then 🟡 FYI, whatever order the model used', () => {
    const { text } = run(`*🟡 FYI / Needs Awareness*\n${line(3)}\n\n*👀 Watching*\n${line(2, ' (owner: Kelsey Dempsey)')}\n\n*🔴 Action Required*\n${line(1)}`);
    const at = (s) => text.indexOf(s);
    expect(at('🔴 Action Required')).toBeGreaterThan(-1);
    expect(at('🔴 Action Required')).toBeLessThan(at('👀 Watching'));
    expect(at('👀 Watching')).toBeLessThan(at('🟡 FYI'));
  });

  it('omits buckets with nothing in them, and says so plainly when there is nothing at all', () => {
    const only = run(`*🟡 FYI / Needs Awareness*\n${line(3)}`);
    expect(only.text).not.toContain('Action Required');
    expect(only.text).not.toContain('Watching');
    const none = run('*🌅 Morning Digest*\n');
    expect(none.empty).toBe(true);
    expect(none.text).toContain('Nothing new needs your attention');
  });
});

describe('the post ends after the last bucket', () => {
  it('strips the "N emails total" line and any count footnotes the model adds', () => {
    const { text } = run(
      `*🔴 Action Required*\n${line(1)}\n\n*🟡 FYI / Needs Awareness*\n${line(3)}\n\n` +
      `*14 emails total — 2 need action*\n_🗑️ 3 spam emails auto-archived_\n_🧹 2 suspected spam filtered_\n_📝 2 reply drafts waiting_\n_🗂 Filed 4 emails_`
    );
    expect(text).not.toMatch(/emails total|need action|spam|drafts|Filed/i);
    expect(text.trim().endsWith('summary')).toBe(true);
  });

  it('drops a System Alerts or Low Priority section the model still writes', () => {
    const { text } = run(
      `*🔧 System Alerts*\n- Zapier — delinquency-outreach failed\n\n*🔴 Action Required*\n${line(1)}\n\n*⚪ Low Priority / Noise*\n- AppFolio — report ran`
    );
    expect(text).not.toMatch(/System Alerts|Zapier|Low Priority|AppFolio — report/);
    expect(text).toContain('Roof quote');
  });
});

describe('Action Required', () => {
  it('is uncapped, keeps its [#N] numbers and grouped blocks', () => {
    const lines = candidates.map((_, i) => line(i + 1)).join('\n');
    const { text } = run(`*🔴 Action Required*\n${lines}`);
    for (let n = 1; n <= 10; n += 1) expect(text).toContain(`[#${n}]`);
    expect(text).not.toContain('more, not listed');

    const grouped = run(`*🔴 Action Required*\n*Roof & gutters*\n  ↳ [#1] Alice Anders — Roof quote: x\n  ↳ [#2] Bob Baker — Gutter cleaning: y`);
    expect(grouped.text).toContain('*Roof & gutters*');
    expect(grouped.text).toContain('↳ [#2] Bob Baker');
  });
});

describe('Watching and FYI: numbers off, 5 items each, one overflow line', () => {
  it('strips the [#N] numbers from Watching and FYI lines (only Action Required is numbered)', () => {
    const { text } = run(`*👀 Watching*\n${line(2, ' (owner: Kelsey)')}\n\n*🟡 FYI / Needs Awareness*\n${line(3)}`);
    expect(text).not.toMatch(/\[#\d+\]/);
    expect(text).toContain('- Bob Baker — Gutter cleaning');
    expect(text).toContain('- Carol Chen — Lease renewal');
  });

  it('caps each bucket at 5 and ends it with "…and N more, not listed"', () => {
    const watching = [1, 2, 3, 4, 5, 6, 7].map((n) => line(n, ' (owner: Kelsey)')).join('\n');
    const fyi = [8, 9, 10].map((n) => line(n)).join('\n');
    const { text, stats } = run(`*👀 Watching*\n${watching}\n\n*🟡 FYI / Needs Awareness*\n${fyi}`);
    const watchBlock = text.slice(text.indexOf('*👀 Watching*'), text.indexOf('*🟡 FYI'));
    expect(watchBlock.match(/^- /gm)).toHaveLength(MAX_BUCKET_ITEMS);
    expect(watchBlock).toContain('…and 2 more, not listed');
    // The overflow line is the bucket's last line, inside the bucket.
    expect(watchBlock.trim().split('\n').pop()).toBe('_…and 2 more, not listed_');
    const fyiBlock = text.slice(text.indexOf('🟡 FYI'));
    expect(fyiBlock.match(/^- /gm)).toHaveLength(3);
    expect(fyiBlock).not.toContain('more, not listed');
    expect(stats).toMatchObject({ watching_shown: 5, watching_more: 2, fyi_shown: 3, fyi_more: 0 });
  });

  it('shows the top 5 in the model\'s order ("most important first")', () => {
    const fyi = [10, 9, 8, 7, 6, 5, 4].map((n) => line(n)).join('\n');
    const { text } = run(`*🟡 FYI / Needs Awareness*\n${fyi}`);
    const order = [...text.matchAll(/^- (\w+) /gm)].map((m) => m[1]);
    expect(order).toEqual(['Jo', 'Ian', 'Hana', 'Gus', 'Fay']);
    expect(text).toContain('…and 2 more, not listed');
  });

  it('every Watching line names an owner (flagged as unclear if the model forgot)', () => {
    const { text } = run(`*👀 Watching*\n${line(2, ' (owner: Kelsey Dempsey)')}\n${line(3)}`);
    expect(text).toContain('(owner: Kelsey Dempsey)');
    expect(text).toContain('Carol Chen — Lease renewal: summary (owner: unclear)');
  });

  it('does not repeat an email in a lower bucket when the model lists it twice', () => {
    const { text } = run(`*🔴 Action Required*\n${line(1)}\n\n*👀 Watching*\n${line(1, ' (owner: x)')}\n${line(2, ' (owner: y)')}\n\n*🟡 FYI / Needs Awareness*\n${line(2)}`);
    expect(text.match(/Roof quote/g)).toHaveLength(1);
    expect(text.match(/Gutter cleaning/g)).toHaveLength(1);
    // Bob stays in Watching (the higher bucket); there is no FYI left to show.
    expect(text).not.toContain('FYI');
  });
});

describe('hard floors', () => {
  it('rank in before the cap: a floor item buried at #9 still makes the top 5', () => {
    const fyi = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => line(n)).join('\n');
    const floors = new Map([[9, 'insurance mail']]);
    const { text } = run(`*🟡 FYI / Needs Awareness*\n${fyi}`, floors);
    const listed = [...text.matchAll(/^- (\w+) /gm)].map((m) => m[1]);
    expect(listed).toHaveLength(5);
    expect(listed[0]).toBe('Ian'); // the floor item, moved to the front
    expect(listed.slice(1)).toEqual(['Alice', 'Bob', 'Carol', 'Dan']);
    expect(text).toContain('…and 4 more, not listed');
  });

  it('puts a must-show email the model discarded back in, as FYI', () => {
    const floors = new Map([[4, 'priority sender: Rhoda Altom'], [6, 'money mail']]);
    const { text, stats } = run(`*🔴 Action Required*\n${line(1)}`, floors);
    expect(text).toContain('🟡 FYI');
    expect(text).toContain('- Dan Diaz — Boiler inspection: Preview text.');
    expect(text).toContain('- Fay Fong — Move-out walkthrough: Preview text.');
    expect(stats.floor_backfilled).toBe(2);
  });

  it('puts it back even if the model filed it under a section that is not shown', () => {
    const { text } = run(`*🔧 System Alerts*\n${line(4)}\n\n*⚪ Low Priority / Noise*\n${line(6)}`, new Map([[4, 'x'], [6, 'y']]));
    expect(text).toContain('Dan Diaz');
    expect(text).toContain('Fay Fong');
  });

  it('does not duplicate a floor item the model did show (in any bucket)', () => {
    const floors = new Map([[1, 'a'], [2, 'b'], [3, 'c']]);
    const { text, stats } = run(`*🔴 Action Required*\n${line(1)}\n\n*👀 Watching*\n${line(2, ' (owner: z)')}\n\n*🟡 FYI / Needs Awareness*\n${line(3)}`, floors);
    for (const subject of ['Roof quote', 'Gutter cleaning', 'Lease renewal']) expect(text.match(new RegExp(subject, 'g'))).toHaveLength(1);
    expect(stats.floor_backfilled).toBe(0);
  });

  it('a wrong [#N] cannot make a different email look "shown"', () => {
    // The line says [#4] but describes Alice (#1). Dan (#4) is a floor item and was NOT shown.
    const { text } = run(`*🟡 FYI / Needs Awareness*\n- [#4] Alice Anders — Roof quote: x`, new Map([[4, 'x']]));
    expect(text).toContain('Dan Diaz — Boiler inspection');
  });

  it('never drops a floor item to the cap: more than 5 floors all show', () => {
    const fyi = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => line(n)).join('\n');
    const floors = new Map([1, 2, 3, 4, 5, 6, 7].map((n) => [n, 'money mail']));
    const { text } = run(`*🟡 FYI / Needs Awareness*\n${fyi}`, floors);
    expect([...text.matchAll(/^- /gm)]).toHaveLength(7);
    expect(text).toContain('…and 1 more, not listed');
  });

  it('a floor item whose ask is addressed to someone else still lands in Watching, not FYI', () => {
    const { text } = run(`*👀 Watching*\n${line(2, ' (owner: Kelsey Dempsey)')}`, new Map([[2, 'priority sender: Rhoda Altom']]));
    expect(text.slice(text.indexOf('👀 Watching'))).toContain('Bob Baker');
    expect(text).not.toContain('FYI');
  });
});

describe('what the auto-filer is told was surfaced', () => {
  it('includes items the 5-item cap hid, so they are never filed away unseen', () => {
    const fyi = [1, 2, 3, 4, 5, 6, 7].map((n) => line(n)).join('\n');
    const { text, surfacedText } = run(`*🟡 FYI / Needs Awareness*\n${fyi}`);
    expect(text).not.toContain('Window screens');
    expect(surfacedText).toContain('Gus Gray'); // #7 was cut from the post
    expect(surfacedText).toContain('Fay Fong');
  });
});
