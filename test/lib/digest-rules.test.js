import { describe, it, expect, vi } from 'vitest';
import {
  resolveWindow, fetchCapForWindow, isWorkOrderMail, resolvePrioritySenders, sendersMissingAddresses,
  prioritySenderFor, floorTopic, floorReason, formatRecipients, isOwnerCcOnly,
  DEFAULT_PRIORITY_SENDERS,
} from '../../lib/digest-rules';

const OWNER = 'grant@milestoneproperties.net';
const addr = (address, name = '') => ({ emailAddress: { address, name } });
const mail = (overrides = {}) => ({
  subject: 'Hello',
  bodyPreview: 'Just checking in.',
  from: addr('someone@example.com', 'Someone'),
  toRecipients: [addr(OWNER, 'Grant Carlson')],
  ccRecipients: [],
  ...overrides,
});

describe('lookback window: since the last successful digest', () => {
  // 7:30 AM Pacific (PST) on the days of Mon Nov 9 .. Fri Nov 13, 2026.
  const at = (day, hh = 15, mm = 30) => new Date(Date.UTC(2026, 10, day, hh, mm));

  it('is about 24 hours on a normal weekday', () => {
    const w = resolveWindow(at(10).toISOString(), at(11));
    expect(w.hours).toBeCloseTo(24, 5);
    expect(w.source).toBe('since_last_digest');
    expect(w.since).toBe(at(10).toISOString());
  });

  it('is about 72 hours on Monday, so the weekend is covered', () => {
    const w = resolveWindow(at(6).toISOString(), at(9)); // Friday -> Monday
    expect(w.hours).toBeCloseTo(72, 5);
    expect(w.cappedAtMax).toBe(false);
  });

  it('reaches further back after a missed day', () => {
    const w = resolveWindow(at(10).toISOString(), at(12)); // Tue -> Thu (Wed missed)
    expect(w.hours).toBeCloseTo(48, 5);
  });

  it('never looks back more than 96 hours', () => {
    const w = resolveWindow(at(1).toISOString(), at(13)); // 12 days
    expect(w.hours).toBe(96);
    expect(w.cappedAtMax).toBe(true);
    expect(w.since).toBe(new Date(at(13).getTime() - 96 * 3_600_000).toISOString());
  });

  it('falls back to 24 hours when nothing is stored, or what is stored is unusable', () => {
    for (const stored of [null, undefined, '', 'garbage', at(20).toISOString() /* in the future */]) {
      const w = resolveWindow(stored, at(11));
      expect(w.hours).toBe(24);
      expect(w.source).toBe('default_24h');
    }
  });

  it('a forced re-run right after a normal run still looks back a full day', () => {
    const justRan = new Date(at(11).getTime() - 5 * 60_000).toISOString();
    expect(resolveWindow(justRan, at(11)).hours).toBeCloseTo(5 / 60, 5);
    const forced = resolveWindow(justRan, at(11), { force: true });
    expect(forced.hours).toBe(24);
    // ...but force never shrinks a longer window.
    expect(resolveWindow(at(6).toISOString(), at(9), { force: true }).hours).toBeCloseTo(72, 5);
  });
});

describe('fetch cap scales with the window', () => {
  it('is ~100 per 24h, never below 50, capped at 150', () => {
    expect(fetchCapForWindow(24)).toBe(100);
    expect(fetchCapForWindow(48)).toBe(150); // 200 would be over the max
    expect(fetchCapForWindow(72)).toBe(150);
    expect(fetchCapForWindow(96)).toBe(150);
    expect(fetchCapForWindow(500)).toBe(150);
    expect(fetchCapForWindow(12)).toBe(50);
    expect(fetchCapForWindow(1)).toBe(50);
    // A window a few seconds over 24h is still a 24h window.
    expect(fetchCapForWindow(24.003)).toBe(100);
  });
});

describe('work-order mail', () => {
  it('is recognised in the subject, the preview, or the sender, whoever sent it', () => {
    expect(isWorkOrderMail(mail({ subject: 'Work Order #1042-1 completed' }))).toBe(true);
    expect(isWorkOrderMail(mail({ subject: 'New work-order request: Unit 4B' }))).toBe(true);
    expect(isWorkOrderMail(mail({ subject: 'WORKORDER update' }))).toBe(true);
    expect(isWorkOrderMail(mail({ subject: 'Unit 4B faucet', bodyPreview: 'A new work order has been created for Unit 4B.' }))).toBe(true);
    expect(isWorkOrderMail(mail({ from: addr('noreply@appfolio.com', 'AppFolio Work Orders') }))).toBe(true);
    // A person writing about one is still work-order mail: "no exceptions".
    expect(isWorkOrderMail(mail({ subject: 'Re: work orders', from: addr('rhoda@milestoneproperties.net', 'Rhoda Altom') }))).toBe(true);
  });

  it('does not catch ordinary mail', () => {
    expect(isWorkOrderMail(mail({ subject: 'Insurance renewal', bodyPreview: 'Please review the order of events.' }))).toBe(false);
    expect(isWorkOrderMail(mail({ subject: 'Order confirmation', bodyPreview: 'Your purchase order shipped.' }))).toBe(false);
  });
});

describe('hard floor: people, matched by email address', () => {
  const people = resolvePrioritySenders({});

  it('lists the four people, with the addresses the repo knows', () => {
    expect(DEFAULT_PRIORITY_SENDERS.map((p) => p.name)).toEqual(['Rhoda Altom', 'Conor Murphy', 'Caitlin Brisson', 'Helmut Hummes']);
    expect(prioritySenderFor(mail({ from: addr('RHODA@milestoneproperties.net', 'R') }), people)).toBe('Rhoda Altom');
    expect(prioritySenderFor(mail({ from: addr('accounting@milestoneproperties.net', 'Accounting') }), people)).toBe('Conor Murphy');
  });

  it('reports who has no address on file, so it can be logged loudly', () => {
    expect(sendersMissingAddresses(people)).toEqual(['Caitlin Brisson', 'Helmut Hummes']);
  });

  it('takes more addresses from DIGEST_PRIORITY_SENDERS and matches on them', () => {
    const configured = resolvePrioritySenders({
      DIGEST_PRIORITY_SENDERS: JSON.stringify([
        { name: 'Caitlin Brisson', emails: ['Caitlin.Brisson@example.com'] },
        { name: 'helmut hummes', emails: ['helmut@example.org'] },
        { name: 'Conor Murphy', emails: ['conor@milestoneproperties.net'] },
      ]),
    });
    expect(sendersMissingAddresses(configured)).toEqual([]);
    expect(prioritySenderFor(mail({ from: addr('caitlin.brisson@example.com', 'Caitlin') }), configured)).toBe('Caitlin Brisson');
    expect(prioritySenderFor(mail({ from: addr('helmut@example.org') }), configured)).toBe('Helmut Hummes');
    // Both of Conor's addresses count.
    expect(prioritySenderFor(mail({ from: addr('conor@milestoneproperties.net') }), configured)).toBe('Conor Murphy');
    expect(prioritySenderFor(mail({ from: addr('accounting@milestoneproperties.net') }), configured)).toBe('Conor Murphy');
  });

  it('never matches on the display name: Caitlin Sogn at College Club is not Caitlin Brisson', () => {
    const configured = resolvePrioritySenders({
      DIGEST_PRIORITY_SENDERS: JSON.stringify([{ name: 'Caitlin Brisson', emails: ['caitlin.brisson@example.com'] }]),
    });
    expect(prioritySenderFor(mail({ from: addr('caitlin@collegeclub.org', 'Caitlin Sogn') }), configured)).toBeNull();
    // Even a display name that is exactly the priority person's, from some other address.
    expect(prioritySenderFor(mail({ from: addr('caitlin@collegeclub.org', 'Caitlin Brisson') }), configured)).toBeNull();
    expect(floorReason(mail({ from: addr('caitlin@collegeclub.org', 'Caitlin Sogn') }), configured)).toBeNull();
  });

  it('ignores a broken DIGEST_PRIORITY_SENDERS and keeps the built-in list', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fallback = resolvePrioritySenders({ DIGEST_PRIORITY_SENDERS: '{not json' });
    expect(fallback.map((p) => p.name)).toEqual(DEFAULT_PRIORITY_SENDERS.map((p) => p.name));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('hard floor: money, legal, government, insurance', () => {
  const topic = (subject, bodyPreview = '', from = addr('x@example.com')) => floorTopic(mail({ subject, bodyPreview, from }));

  it('catches mail that asks something of Grant or puts something at stake', () => {
    expect(topic('Invoice #4471 - Landscaping services')).toBe('money');
    expect(topic('Past due: 2nd notice')).toBe('money');
    expect(topic('Updated wire instructions')).toBe('money');
    expect(topic('Your loan documents')).toBe('money');
    expect(topic('Emergency motion filed on B-309')).toBe('legal');
    expect(topic('Notice to vacate - Unit 12')).toBe('legal');
    expect(topic('Re: lease', 'Our attorney will be in touch')).toBe('legal');
    expect(topic('Notice of violation at 123 Main')).toBe('government');
    expect(topic('Seattle building permit approved')).toBe('government');
    expect(topic('Update', 'From the King County assessor')).toBe('government');
    expect(topic('Insurance renewal reminder - Kenton property')).toBe('insurance');
    expect(topic('Claim #88 received')).toBe('insurance');
    expect(topic('Your policy renewal')).toBe('insurance');
  });

  it('treats any .gov sender as government mail', () => {
    expect(topic('Hello', '', addr('clerk@seattle.gov'))).toBe('government');
    expect(topic('Hello', '', addr('clerk@kingcounty.wa.gov'))).toBe('government');
    expect(topic('Hello', '', addr('hi@notgov.com'))).toBeNull();
  });

  it('does not flood the digest with routine receipts, newsletters or first names', () => {
    expect(topic('Payment received - Unit 4B')).toBeNull();
    expect(topic('Your weekly AppFolio owner statement is ready')).toBeNull();
    expect(topic('Bill Johnson: lunch Thursday?')).toBeNull();
    expect(topic('We updated our privacy policy')).toBeNull();
    expect(topic('Weekly newsletter: Property management trends')).toBeNull();
    expect(topic('Your Adobe Acrobat comment', 'Someone commented on a shared PDF document.')).toBeNull();
  });

  it('gives a reason that names the person or the topic', () => {
    const people = resolvePrioritySenders({});
    expect(floorReason(mail({ from: addr('rhoda@milestoneproperties.net') }), people)).toBe('priority sender: Rhoda Altom');
    expect(floorReason(mail({ subject: 'Invoice 9' }), people)).toBe('money mail');
    expect(floorReason(mail(), people)).toBeNull();
  });
});

describe('addressees', () => {
  it('lists To/Cc recipients as "Name <address>", with a bound on very long lists', () => {
    expect(formatRecipients([addr('a@x.com', 'Alice A'), addr('b@x.com')])).toBe('Alice A <a@x.com>, b@x.com');
    expect(formatRecipients([])).toBe('(none)');
    expect(formatRecipients(undefined)).toBe('(none)');
    const many = Array.from({ length: 12 }, (_, i) => addr(`p${i}@x.com`));
    expect(formatRecipients(many)).toMatch(/p7@x\.com, \+4 more$/);
  });

  it('notices when Grant is only cc\'d', () => {
    expect(isOwnerCcOnly(mail({ toRecipients: [addr('kelsey@x.com')], ccRecipients: [addr('GRANT@milestoneproperties.net')] }), OWNER)).toBe(true);
    expect(isOwnerCcOnly(mail({ toRecipients: [addr(OWNER)], ccRecipients: [addr(OWNER)] }), OWNER)).toBe(false);
    expect(isOwnerCcOnly(mail({ toRecipients: [addr(OWNER)] }), OWNER)).toBe(false);
    // Reached him some other way (Bcc / a list): not flagged.
    expect(isOwnerCcOnly(mail({ toRecipients: [addr('team@x.com')], ccRecipients: [] }), OWNER)).toBe(false);
  });
});
