import { describe, it, expect } from 'vitest';
import { createFakeSupabase } from '../support/fake-supabase';
import { autoFileNoise, putBack, keepReason, proposeNoise, MAX_FILED_PER_DAY } from '../../lib/auto-file';
import { buildFiledListBlocks, markFiledRowRestored, filedButtonBlock, buildTodoBlocks, EMAIL_ACTIONS } from '../../lib/inbox-blocks';
import { TRIAGE_FOLDERS } from '../../lib/mailbox-folders';

const OWNER = 'grant@milestoneproperties.net';

function email(id, { name = 'Sender', address = `${id}@example.com`, subject = `Subject ${id}`, preview = '', importance = 'normal' } = {}) {
  return { id, subject, bodyPreview: preview, importance, from: { emailAddress: { name, address } } };
}
function row(e, n) {
  return { id: `item-${e.id}`, item_number: n, graph_message_id: e.id, sender_name: e.from.emailAddress.name, sender_email: e.from.emailAddress.address, subject: e.subject, action_status: 'open' };
}
function fakeClaude(indices) {
  const calls = [];
  return {
    calls,
    call: async (args) => {
      calls.push(args);
      return { content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: JSON.stringify(indices) }] };
    },
  };
}
function fakeOutlook() {
  const moves = [];
  let n = 0;
  const graph = async (_t, path, method, body) => {
    const m = path.match(/\/messages\/([^/]+)\/move$/);
    if (m && method === 'POST') {
      n += 1;
      moves.push({ from: m[1], to: body.destinationId });
      return { id: `moved-${n}-${m[1]}` };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { graph, moves };
}

const NOISE = [
  email('receipt', { name: 'Amazon', address: 'auto-confirm@amazon.com', subject: 'Your order has shipped' }),
  email('appfolio', { name: 'AppFolio', address: 'noreply@appfolio.com', subject: 'Your report is ready' }),
  email('newsletter', { name: 'RHAWA News', address: 'news@rhawa.org', subject: 'This week in housing' }),
];

describe('filing noise out of the inbox', () => {
  function run({ emails, indices, stats = new Map(), exceptions = [], surfaced = '', auth = new Set(), supabase } = {}) {
    const db = supabase || createFakeSupabase({
      digest_items: emails.map((e, i) => row(e, i + 1)),
      auto_file_exceptions: exceptions.map((s) => ({ owner_email: OWNER, sender_email: s })),
    });
    const outlook = fakeOutlook();
    let folderLookups = 0;
    return autoFileNoise({
      supabase: db, graph: outlook.graph, token: 't', ownerEmail: OWNER,
      callClaude: fakeClaude(indices).call, emails, savedItems: db.db.digest_items,
      correspondentStats: stats, surfacedText: surfaced, authFlaggedIds: auth,
      resolveFolderId: async () => { folderLookups += 1; return 'folder-filed'; },
    }).then((res) => ({ res, db, outlook, folderLookups }));
  }

  it('moves clear noise to Filed by Bot and records the new message id', async () => {
    const { res, db, outlook, folderLookups } = await run({ emails: NOISE, indices: [0, 1, 2] });
    expect(res.filed.map((f) => f.graph_message_id)).toEqual(['receipt', 'appfolio', 'newsletter']);
    expect(outlook.moves.every((m) => m.to === 'folder-filed')).toBe(true);
    expect(folderLookups).toBe(1);
    expect(db.db.digest_items[0]).toMatchObject({ action_status: 'filed', filed_message_id: 'moved-1-receipt' });
    expect(TRIAGE_FOLDERS.filed_by_bot).toBe('Filed by Bot');
  });

  it('hard rules override the model: people Grant writes to, money/deadlines, flagged, important, surfaced, rescued senders', async () => {
    const emails = [
      email('coworker', { name: 'Jacque Altom', address: 'jacque@milestone.com', subject: 'Weekly update' }),
      email('invoice', { name: 'Vendor', address: 'billing@vendor.com', subject: 'Invoice 4471 past due' }),
      email('spoof', { name: 'Chase', address: 'alerts@ch4se.com', subject: 'Statement' }),
      email('important', { name: 'Lender', address: 'x@bank.com', subject: 'FYI', importance: 'high' }),
      email('surfaced', { name: 'RHAWA Events', address: 'events@rhawa.org', subject: 'ENGAGE26 advance rate expires' }),
      email('rescued', { name: 'USI', address: 'marla@usi.com', subject: 'Newsletter' }),
      ...NOISE,
    ];
    const stats = new Map([['jacque@milestone.com', { outbound_count: 12 }]]);
    const { res, outlook } = await run({
      emails, indices: emails.map((_, i) => i), stats,
      exceptions: ['marla@usi.com'], surfaced: '- RHAWA Events — ENGAGE26 advance rate expires September 30',
      auth: new Set(['spoof']),
    });
    expect(outlook.moves.map((m) => m.from)).toEqual(['receipt', 'appfolio', 'newsletter']);
    expect(Object.fromEntries(res.kept.map((k) => [k.email.id, k.reason]))).toEqual({
      coworker: 'someone Grant writes to',
      invoice: 'money, deadline, legal, or emergency',
      spoof: 'failed sender check',
      important: 'marked important',
      surfaced: 'shown in the digest',
      rescued: 'sender was put back before',
    });
  });

  it('files nothing if it cannot read the put-back list (never re-files a rescued sender)', async () => {
    const db = createFakeSupabase({ digest_items: NOISE.map((e, i) => row(e, i + 1)) });
    const broken = { ...db, from: (t) => (t === 'auto_file_exceptions'
      ? { select: () => ({ eq: async () => ({ data: null, error: { message: 'down' } }) }) }
      : db.from(t)) };
    const { res, outlook } = await run({ emails: NOISE, indices: [0, 1, 2], supabase: broken });
    expect(res.filed).toEqual([]);
    expect(outlook.moves).toEqual([]);
  });

  it(`files at most ${MAX_FILED_PER_DAY} a day, and a failed move doesn't stop the rest`, async () => {
    const many = Array.from({ length: 50 }, (_, i) => email(`n${i}`, { subject: 'Your receipt' }));
    const { res } = await run({ emails: many, indices: many.map((_, i) => i) });
    expect(res.filed).toHaveLength(MAX_FILED_PER_DAY);
  });

  it('keeps legal, emergency, and building-emergency mail no matter what', () => {
    const ctx = { correspondentStats: new Map(), exceptions: new Set(), surfacedText: '', authFlaggedIds: new Set() };
    for (const subject of ['Emergency motion filed on B-309', 'Water leak in unit 204', 'Subpoena for records', 'Your attorney update']) {
      expect(keepReason(email('x', { subject }), ctx)).toBe('money, deadline, legal, or emergency');
    }
    expect(keepReason(email('x', { subject: 'Your order has shipped' }), ctx)).toBeNull();
  });

  it('ignores junk indices from the model', async () => {
    const got = await proposeNoise({ callClaude: fakeClaude([0, 99, -1, 'x', 1.5]).call, emails: NOISE });
    expect(got).toEqual([0]);
  });
});

describe('putting mail back, across days', () => {
  it('↩️ Put back returns it to the Inbox and that sender is never filed again', async () => {
    const supabase = createFakeSupabase({ digest_items: NOISE.map((e, i) => row(e, i + 1)), auto_file_exceptions: [] });
    const outlook = fakeOutlook();
    const opts = (emails, saved) => ({
      supabase, graph: outlook.graph, token: 't', ownerEmail: OWNER, callClaude: fakeClaude(emails.map((_, i) => i)).call,
      emails, savedItems: saved, correspondentStats: new Map(), surfacedText: '', resolveFolderId: async () => 'folder-filed',
    });

    // Day 1: all three filed.
    await autoFileNoise(opts(NOISE, supabase.db.digest_items));
    const newsletter = supabase.db.digest_items.find((r) => r.graph_message_id === 'newsletter');
    expect(newsletter.action_status).toBe('filed');

    // Grant puts the newsletter back.
    const filedId = newsletter.filed_message_id;
    const back = await putBack({ supabase, graph: outlook.graph, token: 't', ownerEmail: OWNER, item: newsletter });
    expect(back.sender).toBe('news@rhawa.org');
    expect(outlook.moves.at(-1)).toEqual({ from: filedId, to: 'inbox' });
    expect(newsletter.filed_message_id).toBeNull();
    expect(newsletter.action_status).toBe('restored');
    expect(supabase.db.auto_file_exceptions.map((r) => r.sender_email)).toEqual(['news@rhawa.org']);

    // Day 2: a new issue from the same newsletter arrives -- it stays in the inbox.
    const day2 = [email('newsletter2', { name: 'RHAWA News', address: 'news@rhawa.org', subject: 'Next week in housing' }), email('receipt2', { subject: 'Your receipt' })];
    const saved2 = day2.map((e, i) => row(e, i + 1));
    supabase.db.digest_items.push(...saved2);
    const res2 = await autoFileNoise(opts(day2, saved2));
    expect(res2.filed.map((f) => f.graph_message_id)).toEqual(['receipt2']);
    expect(res2.kept[0]).toMatchObject({ reason: 'sender was put back before' });

    // Putting back twice is refused cleanly.
    await expect(putBack({ supabase, graph: outlook.graph, token: 't', ownerEmail: OWNER, item: newsletter })).rejects.toThrow(/not in Filed by Bot/);
  });
});

describe('filed blocks', () => {
  it('adds a "See what I filed" button even when there are no to-dos', () => {
    const blocks = buildTodoBlocks('digest', [], [], [], undefined, filedButtonBlock('run-1', 3));
    const btn = blocks.find((b) => b.block_id === 'filed_list').elements[0];
    expect(btn.text.text).toBe('🗂 See what I filed (3)');
    expect(JSON.parse(btn.value)).toEqual({ runId: 'run-1' });
    expect(filedButtonBlock('run-1', 0)).toEqual([]);
    expect(buildTodoBlocks('digest', [], [], [], undefined, [])).toBeNull();
  });

  it('lists filed emails with ↩️ Put back and marks a restored one', () => {
    const blocks = buildFiledListBlocks([{ id: 'a', sender_name: 'Amazon', subject: 'Shipped' }, { id: 'b', sender_email: 'x@y.com' }]);
    expect(blocks).toHaveLength(3);
    expect(blocks[1].accessory.action_id).toBe(`${EMAIL_ACTIONS.FILED_RESTORE}_a`);
    const after = markFiledRowRestored(blocks, 'a');
    expect(after[1].accessory).toBeUndefined();
    expect(after[1].text.text).toContain("won't file this sender again");
    expect(after[2].accessory).toBeDefined();
  });
});
