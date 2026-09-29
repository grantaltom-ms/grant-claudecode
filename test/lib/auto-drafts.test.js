import { describe, it, expect } from 'vitest';
import { createFakeSupabase } from '../support/fake-supabase';
import { writeAutoDrafts, removeAutoDraft, cleanupStaleDrafts, reviseAutoDraft, ownText, MAX_AUTO_DRAFTS } from '../../lib/auto-drafts';
import { runTodoAction } from '../../lib/todo-actions';
import { buildTodoBlocks, dropDraftFromRow, EMAIL_ACTIONS } from '../../lib/inbox-blocks';

const OWNER = 'grant@milestoneproperties.net';
const day = (n) => new Date(Date.UTC(2026, 9, n, 13, 30));

function item(id, extra = {}) {
  return {
    id, item_number: 1, graph_message_id: `msg-${id}`, graph_conversation_id: `conv-${id}`,
    sender_name: `Sender ${id}`, sender_email: `${id}@example.com`, subject: `Subject ${id}`,
    classification: 'action_required', action_status: 'open', created_at: day(1).toISOString(), ...extra,
  };
}

// A fake Outlook: messages, drafts (with lastModifiedDateTime), sent mail.
function fakeOutlook() {
  const drafts = new Map();
  const calls = [];
  let n = 0;
  const graph = async (_t, path, method = 'GET', body = null) => {
    calls.push({ path, method, body });
    if (path.includes('/mailFolders/sentitems/messages')) {
      return { value: [
        { body: { content: 'Hi Marla,<br>Thanks — will get this back to you today.<br><br>Grant<br>On Mon, Sep 28 Marla wrote: old stuff' } },
        { body: { content: 'Sounds good. Let\'s do Tuesday.\n\nGrant' } },
      ] };
    }
    if (/\/messages\?\$filter=/.test(path)) return { value: [] };
    const createReply = path.match(/\/messages\/([^/]+)\/createReply$/);
    if (createReply) {
      if (createReply[1] === 'msg-bad') throw new Error('Graph 500');
      n += 1;
      const d = { id: `draft-${n}`, isDraft: true, lastModifiedDateTime: `2026-10-01T00:00:0${n}Z`, comment: body.comment, cc: body.message?.ccRecipients };
      drafts.set(d.id, d);
      return d;
    }
    const msg = path.match(/\/messages\/([^/?]+)(\?.*)?$/);
    if (msg && method === 'DELETE') {
      drafts.delete(msg[1]);
      return {};
    }
    if (msg && drafts.has(msg[1])) return drafts.get(msg[1]);
    if (msg && msg[1].startsWith('draft-')) throw new Error('Graph 404 ErrorItemNotFound');
    if (msg) {
      return {
        subject: `Subject for ${msg[1]}`, conversationId: `conv-${msg[1]}`,
        from: { emailAddress: { name: 'Marla Branch', address: 'marla@usi.com' } },
        ccRecipients: [{ emailAddress: { address: 'conor@example.com' } }],
        body: { content: 'Please send the supplemental application by Friday.' },
      };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { graph, drafts, calls };
}

function fakeClaude(reply = { needs_reply: true, body: 'Hi Marla,\n\nWill send it by [day].\n\nGrant', blanks: ['[day]'] }) {
  const prompts = [];
  const call = async ({ system, messages }) => {
    prompts.push({ system, user: messages[0].content });
    const r = typeof reply === 'function' ? reply(messages[0].content) : reply;
    return { content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: JSON.stringify(r) }] };
  };
  return { call, prompts };
}

describe('writing drafts', () => {
  it('writes a threaded reply draft per item, keeps CCs, and links it to the to-do', async () => {
    const supabase = createFakeSupabase({ digest_items: [item('a'), item('b')], draft_feedback: [
      { owner_email: OWNER, user_feedback: 'Never say "per my last email"', created_at: '2026-09-01' },
    ] });
    const outlook = fakeOutlook();
    const claude = fakeClaude();
    const drafted = await writeAutoDrafts({ supabase, graph: outlook.graph, token: 't', ownerEmail: OWNER, callClaude: claude.call, items: supabase.db.digest_items, now: day(1) });

    expect(drafted.map((d) => d.id)).toEqual(['a', 'b']);
    const saved = supabase.db.digest_items.find((r) => r.id === 'a');
    expect(saved.auto_draft_id).toMatch(/^draft-/);
    expect(saved.auto_draft_body).toContain('Will send it by [day].');
    const createCall = outlook.calls.find((c) => c.path.endsWith('/messages/msg-a/createReply'));
    expect(createCall.body.comment).toContain('<div>Will send it by [day].</div>');
    expect(createCall.body.message.ccRecipients[0].emailAddress.address).toBe('conor@example.com');
  });

  it('learns voice from Grant\'s own sent text and past corrections, and forbids invented facts', async () => {
    const supabase = createFakeSupabase({ digest_items: [item('a')], draft_feedback: [
      { owner_email: OWNER, user_feedback: 'Never say "per my last email"', created_at: '2026-09-01' },
    ] });
    const outlook = fakeOutlook();
    const claude = fakeClaude();
    await writeAutoDrafts({ supabase, graph: outlook.graph, token: 't', ownerEmail: OWNER, callClaude: claude.call, items: supabase.db.digest_items });
    const { system, user } = claude.prompts[0];
    expect(user).toContain('Thanks — will get this back to you today.');
    expect(user).not.toContain('old stuff'); // quoted history stripped from samples
    expect(user).toContain('Never say "per my last email"');
    expect(user).toContain('Please send the supplemental application by Friday.');
    expect(system).toMatch(/Never invent facts/);
    expect(system).toMatch(/\[square brackets\]/);
  });

  it('skips emails that don\'t need a reply, and one failure doesn\'t stop the rest', async () => {
    const supabase = createFakeSupabase({ digest_items: [item('a'), item('bad'), item('c')] });
    const outlook = fakeOutlook();
    const claude = fakeClaude((user) => (user.includes('msg-c') || user.includes('Subject for msg-c')
      ? { needs_reply: false, body: '' }
      : { needs_reply: true, body: 'Hi,\n\nGot it.\n\nGrant' }));
    const drafted = await writeAutoDrafts({ supabase, graph: outlook.graph, token: 't', ownerEmail: OWNER, callClaude: claude.call, items: supabase.db.digest_items });
    expect(drafted.map((d) => d.id)).toEqual(['a']);
    expect(outlook.drafts.size).toBe(1);
  });

  it(`drafts at most ${MAX_AUTO_DRAFTS} a morning and never re-drafts an item that already has one`, async () => {
    const rows = Array.from({ length: 12 }, (_, i) => item(`i${i}`));
    rows[0].auto_draft_id = 'existing';
    const supabase = createFakeSupabase({ digest_items: rows });
    const outlook = fakeOutlook();
    const drafted = await writeAutoDrafts({ supabase, graph: outlook.graph, token: 't', ownerEmail: OWNER, callClaude: fakeClaude().call, items: rows });
    expect(drafted).toHaveLength(MAX_AUTO_DRAFTS);
    expect(drafted.some((d) => d.id === 'i0')).toBe(false);
  });

  it('ownText cuts quoted history', () => {
    expect(ownText('Sounds good.\n\nOn Tue, Sep 1 Bob wrote:\n> earlier')).toBe('Sounds good.');
  });
});

describe('refining, deleting, and cleanup over several days', () => {
  it('revise writes the new draft before deleting the old one', async () => {
    const supabase = createFakeSupabase({ digest_items: [item('a')] });
    const outlook = fakeOutlook();
    await writeAutoDrafts({ supabase, graph: outlook.graph, token: 't', ownerEmail: OWNER, callClaude: fakeClaude().call, items: supabase.db.digest_items });
    const before = supabase.db.digest_items[0].auto_draft_id;
    const res = await reviseAutoDraft({ supabase, graph: outlook.graph, token: 't', ownerEmail: OWNER, item: supabase.db.digest_items[0], body: 'Shorter.\n\nGrant' });
    const order = outlook.calls.map((c) => `${c.method} ${c.path}`);
    const createIdx = order.findLastIndex((c) => c.includes('createReply'));
    const deleteIdx = order.findIndex((c) => c === `DELETE /users/${OWNER}/messages/${before}`);
    expect(createIdx).toBeLessThan(deleteIdx);
    expect(outlook.drafts.has(before)).toBe(false);
    expect(outlook.drafts.has(res.draft_id)).toBe(true);
    expect(supabase.db.digest_items[0].auto_draft_body).toBe('Shorter.\n\nGrant');
  });

  it('cleanup deletes untouched drafts after 3 days but never one Grant edited', async () => {
    const supabase = createFakeSupabase({ digest_items: [item('untouched'), item('edited'), item('sent')] });
    const outlook = fakeOutlook();
    await writeAutoDrafts({ supabase, graph: outlook.graph, token: 't', ownerEmail: OWNER, callClaude: fakeClaude().call, items: supabase.db.digest_items, now: day(1) });
    const byId = (id) => supabase.db.digest_items.find((r) => r.id === id);
    // Grant edits one draft in Outlook, and sends another (it leaves Drafts).
    outlook.drafts.get(byId('edited').auto_draft_id).lastModifiedDateTime = '2026-10-01T18:00:00Z';
    outlook.drafts.delete(byId('sent').auto_draft_id);

    expect(await cleanupStaleDrafts({ supabase, graph: outlook.graph, token: 't', ownerEmail: OWNER, now: day(2) })).toEqual({ deleted: 0, kept: 0 });
    const day5 = await cleanupStaleDrafts({ supabase, graph: outlook.graph, token: 't', ownerEmail: OWNER, now: day(5) });
    expect(day5).toEqual({ deleted: 1, kept: 1 });
    expect(byId('untouched').auto_draft_id).toBeNull();
    expect(byId('edited').auto_draft_id).not.toBeNull();
    expect(outlook.drafts.has(byId('edited').auto_draft_id)).toBe(true);
    expect(byId('sent').auto_draft_id).toBeNull(); // unlinked, nothing to delete
  });

  it('removeAutoDraft force-deletes even an edited draft (the 🗑 button is explicit)', async () => {
    const supabase = createFakeSupabase({ digest_items: [item('a')] });
    const outlook = fakeOutlook();
    await writeAutoDrafts({ supabase, graph: outlook.graph, token: 't', ownerEmail: OWNER, callClaude: fakeClaude().call, items: supabase.db.digest_items });
    const row = supabase.db.digest_items[0];
    outlook.drafts.get(row.auto_draft_id).lastModifiedDateTime = 'changed';
    expect(await removeAutoDraft({ supabase, graph: outlook.graph, token: 't', ownerEmail: OWNER, item: { ...row } })).toBe('kept_edited');
    expect(await removeAutoDraft({ supabase, graph: outlook.graph, token: 't', ownerEmail: OWNER, item: { ...row }, force: true })).toBe('deleted');
    expect(outlook.drafts.size).toBe(0);
  });
});

describe('draft buttons', () => {
  async function setup() {
    const supabase = createFakeSupabase({ digest_items: [item('a')] });
    const outlook = fakeOutlook();
    await writeAutoDrafts({ supabase, graph: outlook.graph, token: 't', ownerEmail: OWNER, callClaude: fakeClaude().call, items: supabase.db.digest_items });
    const ctx = { supabase, graph: outlook.graph, getToken: async () => 't', ownerEmail: OWNER, now: day(1), env: {} };
    const click = (prefix) => runTodoAction({ ...ctx, payload: { actions: [{ action_id: `${prefix}_a`, value: JSON.stringify({ itemId: 'a' }) }] } });
    return { supabase, outlook, click };
  }

  it('a drafted item shows 📝 Review draft and a confirm-protected 🗑 Delete draft', () => {
    const blocks = buildTodoBlocks('d', [{ id: 'a', item_number: 1, subject: 'S', auto_draft_id: 'draft-1' }], [], [], (i) => i.subject);
    const row = blocks.find((b) => b.type === 'actions');
    expect(row.elements.map((e) => e.text?.text).filter(Boolean)).toEqual(['📝 Review draft', '✅ Done', '💤 Tomorrow', '🗑 Delete draft']);
    expect(row.elements.find((e) => e.action_id.startsWith(EMAIL_ACTIONS.DELETE_DRAFT)).confirm).toBeDefined();
    expect(blocks.find((b) => b.type === 'context').elements[0].text).toContain('draft ready in Outlook');
    const after = dropDraftFromRow(blocks, 'a');
    expect(after.find((b) => b.block_id === 'todo_a').elements.map((e) => e.text?.text).filter(Boolean)).toEqual(['✍️ Reply', '✅ Done', '💤 Tomorrow']);
    expect(after.find((b) => b.type === 'context').elements[0].text).not.toContain('draft ready');
  });

  it('📝 Review draft posts the draft text with a ref the bot can use to rewrite it', async () => {
    const { click } = await setup();
    const out = await click(EMAIL_ACTIONS.REVIEW_DRAFT);
    expect(out.mode).toBe('post');
    expect(out.outcome).toContain('Will send it by [day].');
    expect(out.outcome).toContain('`ref: a`');
  });

  it('🗑 Delete draft removes it from Outlook but keeps the item on the list', async () => {
    const { supabase, outlook, click } = await setup();
    const out = await click(EMAIL_ACTIONS.DELETE_DRAFT);
    expect(out.mode).toBe('dropDraft');
    expect(outlook.drafts.size).toBe(0);
    expect(supabase.db.digest_items[0]).toMatchObject({ action_status: 'open', auto_draft_id: null });
  });

  it('✅ Done also clears an untouched draft, but keeps one Grant edited and says so', async () => {
    const one = await setup();
    await one.click(EMAIL_ACTIONS.DONE);
    expect(one.outlook.drafts.size).toBe(0);

    const two = await setup();
    const row = two.supabase.db.digest_items[0];
    two.outlook.drafts.get(row.auto_draft_id).lastModifiedDateTime = 'edited';
    const out = await two.click(EMAIL_ACTIONS.DONE);
    expect(out.outcome).toContain('your edited draft was kept');
    expect(two.outlook.drafts.size).toBe(1);
  });
});
