import { describe, it, expect } from 'vitest';
import { createFakeSupabase } from '../support/fake-supabase';
import {
  markActionItems, loadCarryOver, sweepCarryOver, formatCarryOverSection,
  handoffContacts, tomorrowPacific, sinceLabel, dropRepliedEmails, EXPIRE_AFTER_DAYS,
} from '../../lib/todo';
import { runTodoAction } from '../../lib/todo-actions';
import { buildTodoBlocks, resolveTodoRow, EMAIL_ACTIONS } from '../../lib/inbox-blocks';

const OWNER = 'grant@milestoneproperties.net';
const CONTACTS = JSON.stringify([
  { key: 'conor', name: 'Conor', email: 'conor@example.com' },
  { key: 'sabrina', name: 'Sabrina', email: 'sabrina@example.com' },
]);

// 6:30 AM Pacific on consecutive days (PDT = UTC-7).
const day = (n) => new Date(Date.UTC(2026, 9, n, 13, 30));

function savedRow(runId, n, conv, created) {
  return {
    id: `${runId}-${n}`, digest_run_id: runId, item_number: n,
    graph_message_id: `msg-${conv}`, graph_conversation_id: conv,
    sender_name: `Sender ${conv}`, sender_email: `${conv}@example.com`,
    subject: `Subject ${conv}`, received_at: created.toISOString(), created_at: created.toISOString(),
    classification: 'digest_candidate', action_status: 'open',
  };
}

// Simulates the Graph calls the to-do list makes: Sent Items lookups (to see
// whether Grant replied) and forwards (hand-offs).
function fakeGraph({ repliedConversations = new Set(), forwards = [] } = {}) {
  return async (_token, path, method = 'GET', body = null) => {
    if (path.includes('/forward')) {
      forwards.push({ path, body });
      return {};
    }
    if (path.includes('sentitems')) {
      const conv = decodeURIComponent(path).match(/conversationId eq '([^']+)'/)[1];
      return { value: repliedConversations.has(conv) ? [{ sentDateTime: new Date(Date.UTC(2026, 9, 2, 20)).toISOString() }] : [] };
    }
    throw new Error(`unexpected graph call ${method} ${path}`);
  };
}

async function runMorning(supabase, graph, runId, now, todaysRows, actionNumbers) {
  supabase.db.digest_items.push(...todaysRows);
  const todays = await markActionItems(supabase, todaysRows, actionNumbers, actionNumbers.map((n) => `- [#${n}] x`).join('\n'));
  const carry = await sweepCarryOver({
    supabase, graph, token: 't', ownerEmail: OWNER,
    items: (await loadCarryOver(supabase, runId, now)).filter((i) => !todays.some((t) => t.graph_conversation_id === i.graph_conversation_id)),
    now,
  });
  return { todays, carry, text: formatCarryOverSection(carry, now) };
}

function click(actionId, value, selected) {
  return {
    actions: [{ action_id: actionId, value: value && JSON.stringify(value), selected_option: selected && { value: JSON.stringify(selected) } }],
  };
}

describe('running to-do list across several mornings', () => {
  it('carries items over, closes them on Done / reply / expiry, and brings snoozed ones back', async () => {
    const supabase = createFakeSupabase({ digest_items: [], send_log: [] });
    const replied = new Set();
    const forwards = [];
    const graph = fakeGraph({ repliedConversations: replied, forwards });

    // Day 1: three Action Required items (A, B, C) and one FYI item (D).
    const d1 = await runMorning(supabase, graph, 'run1', day(1),
      ['A', 'B', 'C', 'D'].map((c, i) => savedRow('run1', i + 1, c, day(1))), [1, 2, 3]);
    expect(d1.todays.map((t) => t.graph_conversation_id)).toEqual(['A', 'B', 'C']);
    expect(d1.carry.stillOpen).toEqual([]);

    // Grant marks A done and snoozes B to tomorrow.
    const env = { HANDOFF_CONTACTS: CONTACTS };
    await runTodoAction({ payload: click(`${EMAIL_ACTIONS.DONE}_run1-1`, { itemId: 'run1-1' }), supabase, graph, getToken: async () => 't', ownerEmail: OWNER, now: day(1), env });
    await runTodoAction({ payload: click(`${EMAIL_ACTIONS.SNOOZE}_run1-2`, { itemId: 'run1-2' }), supabase, graph, getToken: async () => 't', ownerEmail: OWNER, now: day(1), env });

    // Day 2: C is still open and comes back; A (done) doesn't; B is snoozed
    // until day 2, so it comes back too. One new item E arrives.
    const d2 = await runMorning(supabase, graph, 'run2', day(2), [savedRow('run2', 1, 'E', day(2))], [1]);
    expect(d2.carry.stillOpen.map((i) => i.graph_conversation_id).sort()).toEqual(['B', 'C']);
    expect(d2.text).toContain('📌 Still open from earlier');
    expect(d2.text).toContain('Sender C');
    expect(d2.text).not.toContain('Sender A');

    // Grant replies to C in Outlook; hands E off to Conor.
    replied.add('C');
    const out = await runTodoAction({
      payload: click(`${EMAIL_ACTIONS.HANDOFF}_run2-1`, null, { itemId: 'run2-1', to: 'conor' }),
      supabase, graph, getToken: async () => 't', ownerEmail: OWNER, now: day(2), env,
    });
    expect(out.outcome).toContain('Forwarded to Conor');
    expect(forwards).toHaveLength(1);
    expect(forwards[0].path).toContain('/messages/msg-E/forward');
    expect(forwards[0].body.toRecipients[0].emailAddress.address).toBe('conor@example.com');
    expect(supabase.db.send_log.map((r) => r.recipient)).toEqual(['conor@example.com']);

    // Day 3: C closed itself (Grant replied), E was handed off, B still open.
    const d3 = await runMorning(supabase, graph, 'run3', day(3), [], []);
    expect(d3.carry.stillOpen.map((i) => i.graph_conversation_id)).toEqual(['B']);
    expect(d3.carry.replied.map((i) => i.graph_conversation_id)).toEqual(['C']);
    // Closures are done quietly: the digest reports no counts for them.
    expect(d3.text).not.toMatch(/closed because you replied|To-do list/);
    const byConv = Object.fromEntries(supabase.db.digest_items.map((r) => [r.graph_conversation_id, r.action_status]));
    expect(byConv).toMatchObject({ A: 'done', B: 'snoozed', C: 'replied', D: 'open', E: 'handed_off' });

    // Day 20: B has been open 19 days (past the 7-day limit) -> dropped quietly.
    const d20 = await runMorning(supabase, graph, 'run20', day(20), [], []);
    expect(d20.carry.stillOpen).toEqual([]);
    expect(d20.carry.expired.map((i) => i.graph_conversation_id)).toEqual(['B']);
    expect(d20.text).toBe('');
  });

  it('keeps an unanswered item for 7 days, then drops it', async () => {
    expect(EXPIRE_AFTER_DAYS).toBe(7);
    const supabase = createFakeSupabase({ digest_items: [] });
    const graph = fakeGraph();
    await runMorning(supabase, graph, 'run1', day(1), [savedRow('run1', 1, 'K', day(1))], [1]);

    // 6 days later it is still on the list (it used to be gone after 3)...
    const d7 = await runMorning(supabase, graph, 'run7', day(7), [], []);
    expect(d7.carry.stillOpen.map((i) => i.graph_conversation_id)).toEqual(['K']);
    expect(d7.carry.expired).toEqual([]);

    // ...and 8 days later it has aged out.
    const d9 = await runMorning(supabase, graph, 'run9', day(9), [], []);
    expect(d9.carry.stillOpen).toEqual([]);
    expect(d9.carry.expired.map((i) => i.graph_conversation_id)).toEqual(['K']);
  });

  it('the same email thread never shows twice (today\'s row replaces yesterday\'s)', async () => {
    const supabase = createFakeSupabase({ digest_items: [] });
    const graph = fakeGraph();
    await runMorning(supabase, graph, 'run1', day(1), [savedRow('run1', 1, 'X', day(1))], [1]);
    const d2 = await runMorning(supabase, graph, 'run2', day(2), [savedRow('run2', 4, 'X', day(2))], [4]);
    expect(d2.carry.stillOpen).toEqual([]);
    expect(supabase.db.digest_items.find((r) => r.id === 'run1-1').action_status).toBe('carried');
  });

  it('never closes an item on a guess when the Sent Items check fails', async () => {
    const supabase = createFakeSupabase({ digest_items: [] });
    await runMorning(supabase, fakeGraph(), 'run1', day(1), [savedRow('run1', 1, 'Q', day(1))], [1]);
    const failing = async () => { throw new Error('Graph down'); };
    const d2 = await runMorning(supabase, failing, 'run2', day(2), [], []);
    expect(d2.carry.stillOpen.map((i) => i.graph_conversation_id)).toEqual(['Q']);
  });
});

describe('hand-off safety', () => {
  it('refuses to forward once the daily send limit is reached', async () => {
    const supabase = createFakeSupabase({ digest_items: [savedRow('r', 1, 'Z', day(1))] });
    // checkSendRateLimit counts send_log rows with head:true; the fake can't do
    // counts, so stub the one call it makes.
    const limited = { ...supabase, from: (t) => (t === 'send_log'
      ? { select: () => ({ eq: () => ({ gte: async () => ({ count: 99, error: null }) }) }) }
      : supabase.from(t)) };
    const forwards = [];
    await expect(runTodoAction({
      payload: click(`${EMAIL_ACTIONS.HANDOFF}_r-1`, null, { itemId: 'r-1', to: 'conor' }),
      supabase: limited, graph: fakeGraph({ forwards }), getToken: async () => 't', ownerEmail: OWNER,
      env: { HANDOFF_CONTACTS: CONTACTS },
    })).rejects.toThrow(/send limit/);
    expect(forwards).toHaveLength(0);
    expect(supabase.db.digest_items[0].action_status).toBe('open');
  });

  it('hides the hand-off menu when no contacts are configured, and ignores bad config', () => {
    expect(handoffContacts({})).toEqual([]);
    expect(handoffContacts({ HANDOFF_CONTACTS: 'not json' })).toEqual([]);
    expect(handoffContacts({ HANDOFF_CONTACTS: CONTACTS }).map((c) => c.key)).toEqual(['conor', 'sabrina']);
    const blocks = buildTodoBlocks('digest', [{ id: 'i1', item_number: 1, subject: 's' }], [], []);
    const row = blocks.find((b) => b.type === 'actions');
    expect(row.elements.some((e) => e.type === 'static_select')).toBe(false);
  });
});

describe('to-do blocks', () => {
  it('builds a row per item, marks carried-over items, and stays under Slack\'s 50-block limit', () => {
    const today = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, item_number: i + 1, subject: `T${i}` }));
    const carried = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, subject: `C${i}` }));
    const blocks = buildTodoBlocks('digest text', today, carried, handoffContacts({ HANDOFF_CONTACTS: CONTACTS }), (i) => i.subject);
    expect(blocks.length).toBeLessThanOrEqual(50);
    const labels = blocks.filter((b) => b.type === 'context').map((b) => b.elements[0].text);
    expect(labels[0]).toBe('*#1* · T0');
    expect(labels[5]).toBe('↩ C0');
    const select = blocks.find((b) => b.type === 'actions').elements.find((e) => e.type === 'static_select');
    expect(select.options.map((o) => o.text.text)).toEqual(['➡️ Conor', '➡️ Sabrina']);
  });

  it('replaces only the clicked row with its outcome', () => {
    const blocks = buildTodoBlocks('d', [{ id: 'a', item_number: 1 }, { id: 'b', item_number: 2 }], [], []);
    const after = resolveTodoRow(blocks, 'a', '✅ Done — A');
    expect(after.find((b) => b.block_id === 'todo_a')).toEqual({ type: 'context', block_id: 'todo_a', elements: [{ type: 'mrkdwn', text: '✅ Done — A' }] });
    expect(after.find((b) => b.block_id === 'todo_b').type).toBe('actions');
  });

  it('labels ages in Seattle days and snoozes to tomorrow\'s Seattle date', () => {
    expect(sinceLabel(day(1).toISOString(), day(2))).toBe('since yesterday');
    expect(sinceLabel(day(1).toISOString(), day(9))).toBe('8 days');
    // 11 PM Pacific on Oct 1 is Oct 2 in UTC; tomorrow is still Oct 2 locally.
    expect(tomorrowPacific(new Date('2026-10-02T06:00:00Z'))).toBe('2026-10-02');
  });
});

describe('dropping threads Grant already replied to (digest, before anything is rendered or saved)', () => {
  // Graph's Sent Items lookup, keyed by conversation: the times Grant sent on that thread.
  function sentItemsGraph(sentByConversation, { failFor = new Set(), calls = [] } = {}) {
    return async (_token, path) => {
      const conv = decodeURIComponent(path).match(/conversationId eq '([^']+)'/)[1];
      calls.push(conv);
      if (failFor.has(conv)) throw new Error('Graph is down');
      return { value: (sentByConversation[conv] || []).map((sentDateTime) => ({ sentDateTime })) };
    };
  }
  const mail = (id, receivedDateTime, conversationId = `conv-${id}`) => ({ id, conversationId, receivedDateTime });

  it('drops a thread Grant replied to the same day it arrived, keeps the rest', async () => {
    const calls = [];
    const emails = [
      mail('replied-same-day', '2026-11-05T01:00:00Z'),
      mail('unreplied', '2026-11-05T01:05:00Z'),
      mail('read-but-unreplied', '2026-11-05T01:10:00Z'),
    ];
    const graph = sentItemsGraph({ 'conv-replied-same-day': ['2026-11-05T03:30:00Z'] }, { calls });

    const { kept, dropped, failed } = await dropRepliedEmails({ graph, token: 't', ownerEmail: OWNER, emails });

    expect(dropped.map((e) => e.id)).toEqual(['replied-same-day']);
    expect(kept.map((e) => e.id)).toEqual(['unreplied', 'read-but-unreplied']);
    expect(failed).toBe(0);
  });

  it('only counts a reply sent AFTER the email arrived (a newer message on the thread is new work)', async () => {
    const emails = [
      mail('old-one', '2026-11-04T10:00:00Z', 'conv-thread'),
      mail('new-one', '2026-11-05T09:00:00Z', 'conv-thread'),
    ];
    // Grant answered the first message in the evening; the other side wrote back this morning.
    const graph = sentItemsGraph({ 'conv-thread': ['2026-11-04T20:00:00Z'] });

    const { kept, dropped } = await dropRepliedEmails({ graph, token: 't', ownerEmail: OWNER, emails });

    expect(dropped.map((e) => e.id)).toEqual(['old-one']);
    expect(kept.map((e) => e.id)).toEqual(['new-one']);
  });

  it('asks Graph once per thread, not once per email', async () => {
    const calls = [];
    const emails = [mail('a', '2026-11-05T01:00:00Z', 'conv-x'), mail('b', '2026-11-05T02:00:00Z', 'conv-x'), mail('c', '2026-11-05T03:00:00Z')];
    await dropRepliedEmails({ graph: sentItemsGraph({}, { calls }), token: 't', ownerEmail: OWNER, emails });
    expect(calls.sort()).toEqual(['conv-c', 'conv-x']);
  });

  it('never drops on a guess: a failed Sent Items check keeps the email', async () => {
    const emails = [mail('a', '2026-11-05T01:00:00Z'), mail('b', '2026-11-05T01:00:00Z')];
    const graph = sentItemsGraph({ 'conv-a': ['2026-11-05T05:00:00Z'], 'conv-b': ['2026-11-05T05:00:00Z'] }, { failFor: new Set(['conv-a']) });

    const { kept, dropped, failed } = await dropRepliedEmails({ graph, token: 't', ownerEmail: OWNER, emails });

    expect(kept.map((e) => e.id)).toEqual(['a']);
    expect(dropped.map((e) => e.id)).toEqual(['b']);
    expect(failed).toBe(1);
  });

  it('handles an email with no thread id and an empty list', async () => {
    const graph = sentItemsGraph({});
    const noThread = { id: 'x', receivedDateTime: '2026-11-05T01:00:00Z' };
    expect((await dropRepliedEmails({ graph, token: 't', ownerEmail: OWNER, emails: [noThread] })).kept).toEqual([noThread]);
    expect(await dropRepliedEmails({ graph, token: 't', ownerEmail: OWNER, emails: [] })).toEqual({ kept: [], dropped: [], failed: 0 });
  });
});
