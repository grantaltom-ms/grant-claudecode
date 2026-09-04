import { describe, it, expect } from 'vitest';
import {
  CALENDAR_ACTIONS,
  EMAIL_ACTIONS,
  formatCalendarSummary,
  buildCalendarApprovalBlocks,
  buildDigestBlocks,
  extractDigestItemNumbers,
  verifyDigestItemNumbers,
  formatResolvedMessage,
} from '../../lib/inbox-blocks';

describe('formatCalendarSummary', () => {
  it('formats a create draft with subject, time range, location, and attendees', () => {
    const text = formatCalendarSummary({
      action: 'create',
      subject: 'Meet Eden at Blossoming Buds Preschool',
      start_time: '2026-09-04T07:00:00',
      end_time: '2026-09-04T08:00:00',
      time_zone: 'America/Los_Angeles',
      location: 'Blossoming Buds Preschool',
      attendees: ['eden@example.com', 'crystal.li@becu.org'],
    });

    expect(text).toMatch(/Meet Eden at Blossoming Buds Preschool/);
    expect(text).toMatch(/Fri, Sep 4, 2026/);
    expect(text).toMatch(/7:00 AM – 8:00 AM/);
    expect(text).toMatch(/America\/Los_Angeles/);
    expect(text).toMatch(/Blossoming Buds Preschool/);
    expect(text).toMatch(/eden@example.com, crystal.li@becu.org/);
  });

  it('formats an update draft without repeating a create-style header', () => {
    const text = formatCalendarSummary({
      action: 'update',
      subject: 'Insurance renewal call',
      start_time: '2026-09-05T14:00:00',
      end_time: '2026-09-05T14:30:00',
      time_zone: 'America/Los_Angeles',
    });

    expect(text).toMatch(/Update event/);
    expect(text).toMatch(/Insurance renewal call/);
    expect(text).toMatch(/2:00 PM – 2:30 PM/);
  });

  it('formats a cancel draft with the target event id and comment', () => {
    const text = formatCalendarSummary({
      action: 'cancel',
      target_event_id: 'evt-123',
      cancel_comment: 'Rescheduling, will resend.',
    });

    expect(text).toMatch(/Cancel event/);
    expect(text).toMatch(/evt-123/);
    expect(text).toMatch(/Rescheduling, will resend\./);
  });

  it('never returns an empty string, even for a bare/malformed draft', () => {
    expect(formatCalendarSummary({}).length).toBeGreaterThan(0);
    expect(formatCalendarSummary({ action: 'create' }).length).toBeGreaterThan(0);
    expect(formatCalendarSummary({ action: 'cancel' }).length).toBeGreaterThan(0);
  });

  it('formats wall-clock strings independent of the server TZ', () => {
    const original = process.env.TZ;
    for (const tz of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
      process.env.TZ = tz;
      const text = formatCalendarSummary({
        action: 'create',
        subject: 'TZ check',
        start_time: '2026-09-04T07:00:00',
        end_time: '2026-09-04T08:00:00',
        time_zone: 'America/Los_Angeles',
      });
      expect(text).toMatch(/7:00 AM – 8:00 AM/);
    }
    process.env.TZ = original;
  });
});

describe('buildCalendarApprovalBlocks', () => {
  const draft = {
    id: 'draft-1',
    action: 'create',
    subject: 'Insurance renewal call',
    start_time: '2026-09-05T14:00:00',
    end_time: '2026-09-05T14:30:00',
    time_zone: 'America/Los_Angeles',
  };

  it('produces summary section(s) plus exactly one actions block with three buttons', () => {
    const blocks = buildCalendarApprovalBlocks({ draft, threadTs: 'thread-1' });
    const actionsBlocks = blocks.filter(b => b.type === 'actions');
    const sectionBlocks = blocks.filter(b => b.type === 'section');

    expect(actionsBlocks).toHaveLength(1);
    expect(sectionBlocks.length).toBeGreaterThanOrEqual(1);
    expect(actionsBlocks[0].elements).toHaveLength(3);
    expect(actionsBlocks[0].elements.map(el => el.action_id)).toEqual([
      CALENDAR_ACTIONS.APPLY,
      CALENDAR_ACTIONS.EDIT,
      CALENDAR_ACTIONS.DISCARD,
    ]);
  });

  it('encodes draftId and threadTs into every button value', () => {
    const blocks = buildCalendarApprovalBlocks({ draft, threadTs: 'thread-1' });
    const actionsBlock = blocks.find(b => b.type === 'actions');
    for (const el of actionsBlock.elements) {
      expect(JSON.parse(el.value)).toEqual({ draftId: 'draft-1', threadTs: 'thread-1' });
    }
  });

  it('labels the apply button per action: Book it / Apply / Cancel it', () => {
    const applyLabel = action =>
      buildCalendarApprovalBlocks({ draft: { ...draft, action }, threadTs: 't' })
        .find(b => b.type === 'actions').elements[0].text.text;

    expect(applyLabel('create')).toMatch(/Book it/);
    expect(applyLabel('update')).toMatch(/Apply/);
    expect(applyLabel('cancel')).toMatch(/Cancel it/);
  });

  it('never produces an empty section text (Slack rejects an empty section)', () => {
    const blocks = buildCalendarApprovalBlocks({ draft: { id: 'd', action: 'create' }, threadTs: 't' });
    for (const block of blocks.filter(b => b.type === 'section')) {
      expect(block.text.text.length).toBeGreaterThan(0);
    }
  });

  it('chunks long summary text into multiple sections while keeping one actions block', () => {
    const longDraft = {
      ...draft,
      location: 'x'.repeat(6000),
    };
    const blocks = buildCalendarApprovalBlocks({ draft: longDraft, threadTs: 'thread-1' });
    const sectionBlocks = blocks.filter(b => b.type === 'section');
    const actionsBlocks = blocks.filter(b => b.type === 'actions');

    expect(sectionBlocks.length).toBeGreaterThan(1);
    expect(actionsBlocks).toHaveLength(1);
    for (const block of sectionBlocks) {
      expect(block.text.text.length).toBeLessThanOrEqual(2900);
    }
  });
});

describe('extractDigestItemNumbers', () => {
  const digest = `*🌅 Morning Digest — Thursday, September 4*

*🔴 Action Required*
↳ [#1] harperlawoffices@comcast.net — emergency motion filed
↳ [#2] Gregory Rubio Licht — acknowledged the legal update
[#5] Scott Sanborn — quote ready for signature

*🟡 FYI / Needs Awareness*
- Rhoda — insurance renewal planning (no number)

14 emails total — 3 need action`;

  it('pulls the numbered Action Required items out of the finished digest text', () => {
    expect(extractDigestItemNumbers(digest)).toEqual([1, 2, 5]);
  });

  it('dedupes repeated references and sorts numerically', () => {
    expect(extractDigestItemNumbers('[#10] a [#2] b [#10] c')).toEqual([2, 10]);
  });

  it('returns an empty array when nothing is numbered', () => {
    expect(extractDigestItemNumbers('*Morning Digest* — nothing actionable today')).toEqual([]);
    expect(extractDigestItemNumbers('')).toEqual([]);
    expect(extractDigestItemNumbers(null)).toEqual([]);
  });
});

describe('verifyDigestItemNumbers', () => {
  // Mirrors the real digest_items ordering: the raw inbox order, which is why
  // low numbers are routine mail rather than the curated Action Required set.
  const ITEMS = [
    { item_number: 1, sender_name: 'Milestone Marketing', sender_email: 'leasing@rentmilestone.com', subject: 'Re: Reference Request for Patrick Pruett' },
    { item_number: 4, sender_name: 'ensenta.monitor@jackhenry.com', sender_email: 'ensenta.monitor@jackhenry.com', subject: 'Receipt from Seattle Bank' },
    { item_number: 5, sender_name: 'Githens, Michael', sender_email: 'michael.githens@chase.com', subject: 'RE: [EXTERNAL]Re: Loan Pool Update/ Rate Update' },
    { item_number: 8, sender_name: 'Scott Sanborn', sender_email: 'Scott.Sanborn@alliancels.com', subject: 'Re: Options for high end machines' },
  ];

  it('accepts numbering that genuinely points at the right rows', () => {
    const digest = [
      '*🔴 Action Required*',
      '[#5] Githens, Michael (Chase) — Loan Pool Update: waiting on the appraisal',
      '[#8] Scott Sanborn (Alliance Laundry) — quote ready for signature',
    ].join('\n');

    expect(verifyDigestItemNumbers(digest, ITEMS, [5, 8])).toEqual([5, 8]);
  });

  it('rejects the production failure: model renumbered its items 1, 2, 3', () => {
    // "[#1] Githens" is the bug -- Githens is item 5, so [#1] would resolve to
    // the Patrick Pruett reference request and open a reply to the wrong person.
    const digest = [
      '*🔴 Action Required*',
      '[#1] Githens, Michael (Chase) — Loan Pool Update: waiting on the appraisal',
      '[#2] Scott Sanborn (Alliance Laundry) — quote ready for signature',
    ].join('\n');

    expect(verifyDigestItemNumbers(digest, ITEMS, [1, 2])).toEqual([]);
  });

  it('is all-or-nothing: one bad item drops the buttons for the whole digest', () => {
    const digest = [
      '[#5] Githens, Michael (Chase) — Loan Pool Update',
      '[#8] Somebody Else Entirely — unrelated subject line',
    ].join('\n');

    expect(verifyDigestItemNumbers(digest, ITEMS, [5, 8])).toEqual([]);
  });

  it('corroborates on sender address or subject fragment, not just the name', () => {
    const byEmail = '[#5] <mailto:michael.githens@chase.com|michael.githens@chase.com> — loan update';
    expect(verifyDigestItemNumbers(byEmail, ITEMS, [5])).toEqual([5]);

    const bySubject = '[#8] Alliance — Re: Options for high end machines: quote attached';
    expect(verifyDigestItemNumbers(bySubject, ITEMS, [8])).toEqual([8]);
  });

  it('rejects a number with no saved row, or a number missing from the text', () => {
    expect(verifyDigestItemNumbers('[#5] Githens, Michael — loan update', ITEMS, [5, 99])).toEqual([]);
    expect(verifyDigestItemNumbers('no markers here', ITEMS, [5])).toEqual([]);
  });

  it('returns an empty list when there is nothing to verify', () => {
    expect(verifyDigestItemNumbers('a digest', ITEMS, [])).toEqual([]);
    expect(verifyDigestItemNumbers('a digest', [], [1])).toEqual([]);
  });
});

describe('buildDigestBlocks', () => {
  it('returns null when there are no actionable items, so the digest posts as plain text', () => {
    expect(buildDigestBlocks('a digest with nothing to do', [])).toBeNull();
  });

  it('adds one reply button per item, carrying the item number in the value', () => {
    const blocks = buildDigestBlocks('digest text', [1, 3]);
    const actionsBlocks = blocks.filter(b => b.type === 'actions');
    expect(actionsBlocks).toHaveLength(1);

    const elements = actionsBlocks[0].elements;
    expect(elements).toHaveLength(2);
    expect(elements.map(el => el.text.text)).toEqual(['✍️ Reply #1', '✍️ Reply #3']);
    expect(elements.map(el => JSON.parse(el.value))).toEqual([{ itemNumber: 1 }, { itemNumber: 3 }]);
    expect(elements.every(el => el.action_id.startsWith(EMAIL_ACTIONS.REPLY))).toBe(true);
  });

  it('gives every button a distinct action_id (Slack requires uniqueness within a block)', () => {
    const blocks = buildDigestBlocks('digest text', [1, 2, 3, 4, 5]);
    const ids = blocks
      .filter(b => b.type === 'actions')
      .flatMap(b => b.elements.map(el => el.action_id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('splits into rows of 5 and caps the total number of buttons', () => {
    const blocks = buildDigestBlocks('digest text', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const actionsBlocks = blocks.filter(b => b.type === 'actions');
    expect(actionsBlocks).toHaveLength(2);
    expect(actionsBlocks.every(b => b.elements.length <= 5)).toBe(true);

    const total = actionsBlocks.reduce((sum, b) => sum + b.elements.length, 0);
    expect(total).toBe(10);
  });

  it('keeps the digest text in section blocks ahead of the buttons', () => {
    const blocks = buildDigestBlocks('digest text with [#1] in it', [1]);
    expect(blocks[0].type).toBe('section');
    expect(blocks[0].text.text).toContain('digest text');
    expect(blocks[blocks.length - 1].type).toBe('actions');
  });
});

describe('formatResolvedMessage', () => {
  it('keeps the original text and appends the outcome', () => {
    const result = formatResolvedMessage('📅 *Insurance renewal call*\nFri, Sep 4', '✅ Booked by Grant');
    expect(result).toContain('Insurance renewal call');
    expect(result).toContain('✅ Booked by Grant');
  });

  it('falls back to the outcome alone when the original text is empty', () => {
    expect(formatResolvedMessage('', '✅ Booked by Grant')).toBe('✅ Booked by Grant');
    expect(formatResolvedMessage(null, '✅ Booked by Grant')).toBe('✅ Booked by Grant');
    expect(formatResolvedMessage('   ', '✅ Booked by Grant')).toBe('✅ Booked by Grant');
  });

  it('uses an explicit fallback over the outcome when given one', () => {
    expect(formatResolvedMessage('', '✅ Booked by Grant', 'fallback text')).toBe('fallback text');
  });
});
