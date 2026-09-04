import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import { CHANNEL_ID, APPROVER_USER_ID } from '../pages/api/inbox-assistant';
import {
  parseInteractionPayload,
  handleCalendarInteraction,
  handleEmailInteraction,
  handleInteraction,
} from '../pages/api/inbox-interactions';
import { CALENDAR_ACTIONS, EMAIL_ACTIONS } from '../lib/inbox-blocks';

const DRAFTS_URL = 'https://test-project.supabase.co/rest/v1/calendar_event_drafts';

// A minimal in-memory stand-in for the calendar_event_drafts row. Mirrors the
// real PATCH ... WHERE status='pending' claim/discard semantics: a PATCH
// carrying a status=eq.<x> filter that doesn't match the current row is
// "zero rows updated" -- shaped exactly like real PostgREST (an empty array
// for a plain .select(), a 406 PGRST116 "0 rows" body for .maybeSingle()) so
// the same client code path this app runs in production is exercised here.
function createDraftStore(initial) {
  let draft = { ...initial };
  const get = http.get(DRAFTS_URL, () => HttpResponse.json([draft]));
  const patch = http.patch(DRAFTS_URL, async ({ request }) => {
    const url = new URL(request.url);
    const statusFilter = url.searchParams.get('status');
    const requiredStatus = statusFilter ? statusFilter.replace(/^eq\./, '') : null;
    const body = await request.json();
    const isSingleAccept = request.headers.get('accept') === 'application/vnd.pgrst.object+json';

    if (requiredStatus && draft.status !== requiredStatus) {
      return isSingleAccept
        ? HttpResponse.json(
            {
              code: 'PGRST116',
              details: 'Results contain 0 rows, application/vnd.pgrst.object+json requires 1 row',
              hint: null,
              message: 'JSON object requested, multiple (or no) rows returned',
            },
            { status: 406 }
          )
        : HttpResponse.json([]);
    }

    draft = { ...draft, ...body };
    return isSingleAccept ? HttpResponse.json(draft) : HttpResponse.json([{ id: draft.id }]);
  });

  return {
    get current() { return draft; },
    handlers: [get, patch],
  };
}

// Records every chat.update, chat.postMessage, and Graph event-create call
// into one shared, order-preserving array so tests can assert both counts
// and relative ordering (e.g. the card collapses before Graph is called).
function createTrackedHandlers({ graphStatus = 200 } = {}) {
  const calls = [];
  const chatUpdate = http.post('https://slack.com/api/chat.update', async ({ request }) => {
    calls.push({ type: 'update', body: await request.json() });
    return HttpResponse.json({ ok: true });
  });
  const chatPost = http.post('https://slack.com/api/chat.postMessage', async ({ request }) => {
    calls.push({ type: 'post', body: await request.json() });
    return HttpResponse.json({ ok: true, ts: '9999.0001' });
  });
  const graphCreate = http.post('https://graph.microsoft.com/v1.0/users/:email/events', async ({ request }) => {
    const body = await request.json().catch(() => null);
    calls.push({ type: 'graph', body });
    if (graphStatus >= 400) {
      return HttpResponse.json({ error: { message: 'Internal error' } }, { status: graphStatus });
    }
    return HttpResponse.json({ id: 'evt-test' });
  });
  return { calls, handlers: [chatUpdate, chatPost, graphCreate] };
}

function buildPayload({
  actionId,
  draftId,
  threadTs = 'thread-1',
  userId = APPROVER_USER_ID,
  channelId = CHANNEL_ID,
  messageTs = '100.0001',
  text = '📅 *Insurance renewal call*\nFri, Sep 4, 2026 · 7:00 AM – 8:00 AM (America/Los_Angeles)',
}) {
  return {
    type: 'block_actions',
    channel: { id: channelId },
    user: { id: userId },
    message: { ts: messageTs, thread_ts: threadTs, text },
    actions: [{ action_id: actionId, value: JSON.stringify({ draftId, threadTs }) }],
  };
}

function pendingDraft(overrides = {}) {
  return {
    id: 'draft-1',
    action: 'create',
    target_event_id: null,
    subject: 'Insurance renewal call',
    start_time: '2026-09-05T14:00:00',
    end_time: '2026-09-05T14:30:00',
    time_zone: 'America/Los_Angeles',
    location: null,
    body: null,
    attendees: [],
    cancel_comment: null,
    status: 'pending',
    ...overrides,
  };
}

describe('parseInteractionPayload', () => {
  it('parses a real Slack-style urlencoded payload= body', () => {
    const payloadObj = { type: 'block_actions', actions: [{ action_id: 'calendar_apply' }] };
    const rawBody = new URLSearchParams({ payload: JSON.stringify(payloadObj) }).toString();
    expect(parseInteractionPayload(rawBody)).toEqual(payloadObj);
  });

  it('returns null for garbage or missing input', () => {
    expect(parseInteractionPayload('not=a+payload')).toBeNull();
    expect(parseInteractionPayload('payload=not-json')).toBeNull();
    expect(parseInteractionPayload('')).toBeNull();
  });
});

describe('handleCalendarInteraction: calendar_apply', () => {
  it('collapses the card before calling Graph, calls Graph exactly once, and the final card shows who booked it', async () => {
    const store = createDraftStore(pendingDraft());
    const tracked = createTrackedHandlers();
    server.use(...store.handlers, ...tracked.handlers);

    const payload = buildPayload({ actionId: CALENDAR_ACTIONS.APPLY, draftId: 'draft-1' });
    const result = await handleCalendarInteraction(payload);

    expect(result.handled).toBe(true);
    expect(result.result.success).toBe(true);
    expect(store.current.status).toBe('sent');

    const graphCalls = tracked.calls.filter(c => c.type === 'graph');
    expect(graphCalls).toHaveLength(1);

    const firstUpdateIdx = tracked.calls.findIndex(c => c.type === 'update');
    const graphIdx = tracked.calls.findIndex(c => c.type === 'graph');
    expect(firstUpdateIdx).toBeGreaterThanOrEqual(0);
    expect(firstUpdateIdx).toBeLessThan(graphIdx);

    const updateCalls = tracked.calls.filter(c => c.type === 'update');
    const finalUpdate = updateCalls[updateCalls.length - 1];
    expect(finalUpdate.body.text).toMatch(/✅ Booked by Grant/);
    expect(finalUpdate.body.text).toMatch(/Insurance renewal call/);
    // No blocks/buttons on the resolved card.
    expect(finalUpdate.body.blocks).toEqual([]);
  });

  it('a sequential double-click makes zero extra Graph calls and reports the draft is already handled', async () => {
    const store = createDraftStore(pendingDraft());
    const tracked = createTrackedHandlers();
    server.use(...store.handlers, ...tracked.handlers);

    const payload = buildPayload({ actionId: CALENDAR_ACTIONS.APPLY, draftId: 'draft-1' });
    await handleCalendarInteraction(payload);
    const graphCallsAfterFirst = tracked.calls.filter(c => c.type === 'graph').length;

    const second = await handleCalendarInteraction(payload);

    expect(tracked.calls.filter(c => c.type === 'graph')).toHaveLength(graphCallsAfterFirst);
    expect(second.result.success).toBe(false);
    const posts = tracked.calls.filter(c => c.type === 'post');
    expect(posts[posts.length - 1].body.text).toMatch(/already/);
  });

  it('a concurrent double-click reaches Graph exactly once', async () => {
    const store = createDraftStore(pendingDraft({ id: 'draft-concurrent' }));
    const tracked = createTrackedHandlers();
    server.use(...store.handlers, ...tracked.handlers);

    const payload = buildPayload({ actionId: CALENDAR_ACTIONS.APPLY, draftId: 'draft-concurrent' });
    const [first, second] = await Promise.all([
      handleCalendarInteraction(payload),
      handleCalendarInteraction(payload),
    ]);

    expect(tracked.calls.filter(c => c.type === 'graph')).toHaveLength(1);
    const successes = [first, second].filter(r => r.result.success);
    expect(successes).toHaveLength(1);
    expect(store.current.status).toBe('sent');
  });

  it('a Graph failure marks the draft failed, collapses the card, and reports the error without rethrowing', async () => {
    const store = createDraftStore(pendingDraft({ id: 'draft-fail' }));
    const tracked = createTrackedHandlers({ graphStatus: 500 });
    server.use(...store.handlers, ...tracked.handlers);

    const payload = buildPayload({ actionId: CALENDAR_ACTIONS.APPLY, draftId: 'draft-fail' });
    const result = await handleCalendarInteraction(payload);

    expect(result.handled).toBe(true);
    expect(store.current.status).toBe('failed');

    const updateCalls = tracked.calls.filter(c => c.type === 'update');
    expect(updateCalls[updateCalls.length - 1].body.text).toMatch(/Booking failed/);
    const postCalls = tracked.calls.filter(c => c.type === 'post');
    expect(postCalls[postCalls.length - 1].body.text).toMatch(/Booking failed/);
  });
});

describe('handleCalendarInteraction: calendar_discard', () => {
  it('collapses the card, marks the draft discarded, and never calls Graph', async () => {
    const store = createDraftStore(pendingDraft({ id: 'draft-discard' }));
    const tracked = createTrackedHandlers();
    server.use(...store.handlers, ...tracked.handlers);

    const payload = buildPayload({ actionId: CALENDAR_ACTIONS.DISCARD, draftId: 'draft-discard' });
    const result = await handleCalendarInteraction(payload);

    expect(result.handled).toBe(true);
    expect(store.current.status).toBe('discarded');
    expect(tracked.calls.filter(c => c.type === 'graph')).toHaveLength(0);
    expect(tracked.calls.some(c => c.type === 'update' && c.body.text.includes('Discarded by Grant'))).toBe(true);
  });
});

describe('handleCalendarInteraction: calendar_edit', () => {
  it('collapses the card, discards the old draft, and asks what should change -- no Graph or Anthropic calls', async () => {
    const store = createDraftStore(pendingDraft({ id: 'draft-edit' }));
    const tracked = createTrackedHandlers();
    let anthropicCalls = 0;
    server.use(
      ...store.handlers,
      ...tracked.handlers,
      http.post('https://api.anthropic.com/v1/messages', () => {
        anthropicCalls += 1;
        return HttpResponse.json({
          id: 'msg_unexpected',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'should not be called' }],
          stop_reason: 'end_turn',
        });
      })
    );

    const payload = buildPayload({ actionId: CALENDAR_ACTIONS.EDIT, draftId: 'draft-edit' });
    const result = await handleCalendarInteraction(payload);

    expect(result.handled).toBe(true);
    expect(store.current.status).toBe('discarded');
    expect(tracked.calls.filter(c => c.type === 'graph')).toHaveLength(0);
    expect(anthropicCalls).toBe(0);
    expect(tracked.calls.some(c => c.type === 'post' && c.body.text.includes('What should change'))).toBe(true);
  });
});

// resolve_digest_item reads digest_runs by slack_thread_ts, then digest_items
// by (digest_run_id, item_number), then email_messages by graph_message_id.
function digestLookupHandlers({ item = null } = {}) {
  return [
    http.get('https://test-project.supabase.co/rest/v1/digest_runs', () =>
      HttpResponse.json([{ id: 'run-1', slack_thread_ts: 'digest-ts', status: 'posted' }])
    ),
    http.get('https://test-project.supabase.co/rest/v1/digest_items', () =>
      HttpResponse.json(item ? [item] : [])
    ),
    http.get('https://test-project.supabase.co/rest/v1/email_messages', () => HttpResponse.json([])),
  ];
}

const DIGEST_ITEM = {
  id: 'item-3',
  item_number: 3,
  graph_message_id: 'AAMkGraphMessageId',
  graph_conversation_id: 'conv-3',
  sender_name: 'Scott Sanborn',
  sender_email: 'scott@alliancelaundry.com',
  subject: 'Re: Options for high end machines',
  received_at: '2026-09-03T15:00:00Z',
  classification: 'digest_candidate',
  action_status: 'open',
  raw_digest_input: {},
};

function buildDigestPayload({
  itemNumber = 3,
  userId = APPROVER_USER_ID,
  channelId = CHANNEL_ID,
  messageTs = 'digest-ts',
  text = '*🌅 Morning Digest*\n[#3] Scott Sanborn — quote ready',
} = {}) {
  return {
    type: 'block_actions',
    channel: { id: channelId },
    user: { id: userId },
    // The digest is a top-level message, so its own ts is the thread ts.
    message: { ts: messageTs, text },
    actions: [
      {
        action_id: `${EMAIL_ACTIONS.REPLY}_${itemNumber}`,
        value: JSON.stringify({ itemNumber }),
      },
    ],
  };
}

describe('handleEmailInteraction: ✍️ Reply on a digest item', () => {
  it('opens the conversation in-thread naming the item, sender, and subject', async () => {
    const tracked = createTrackedHandlers();
    server.use(...digestLookupHandlers({ item: DIGEST_ITEM }), ...tracked.handlers);

    const result = await handleEmailInteraction(buildDigestPayload());

    expect(result.handled).toBe(true);
    expect(result.result.success).toBe(true);

    const posts = tracked.calls.filter(c => c.type === 'post');
    expect(posts).toHaveLength(1);
    expect(posts[0].body.thread_ts).toBe('digest-ts');
    expect(posts[0].body.text).toContain('#3');
    expect(posts[0].body.text).toContain('Scott Sanborn');
    expect(posts[0].body.text).toContain('Re: Options for high end machines');
    expect(posts[0].body.text).toMatch(/What do you want to say/);
  });

  it('drafts nothing and calls neither Graph nor Anthropic -- the typed flow does the drafting', async () => {
    const tracked = createTrackedHandlers();
    let anthropicCalls = 0;
    server.use(
      ...digestLookupHandlers({ item: DIGEST_ITEM }),
      ...tracked.handlers,
      http.post('https://api.anthropic.com/v1/messages', () => {
        anthropicCalls += 1;
        return HttpResponse.json({
          id: 'msg_unexpected',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'should not be called' }],
          stop_reason: 'end_turn',
        });
      })
    );

    await handleEmailInteraction(buildDigestPayload());

    expect(anthropicCalls).toBe(0);
    expect(tracked.calls.filter(c => c.type === 'graph')).toHaveLength(0);
    expect(tracked.calls.filter(c => c.type === 'update')).toHaveLength(0);
  });

  it('refuses a stale card whose [#N] does not match the row it resolves to', async () => {
    // The real incident: a digest posted before the numbering fix still
    // carries the old button values, so #7 resolved to Max Ma while the card
    // Grant was reading showed Marriam Leve at [#7]. The card cannot be
    // repaired after the fact, so the click itself has to refuse.
    const staleItem = {
      ...DIGEST_ITEM,
      item_number: 7,
      sender_name: 'Max Ma',
      subject: 'Re: the applicants you say no to',
    };
    const tracked = createTrackedHandlers();
    server.use(...digestLookupHandlers({ item: staleItem }), ...tracked.handlers);

    const result = await handleEmailInteraction(
      buildDigestPayload({
        itemNumber: 7,
        text: '*🌅 Morning Digest*\n[#7] Marriam Leve — Re: Vancouver B&O Tax',
      })
    );

    expect(result.result.success).toBe(false);
    expect(result.result.message).toBe('item_number_not_corroborated');

    const posts = tracked.calls.filter(c => c.type === 'post');
    expect(posts).toHaveLength(1);
    // Names who it would have opened, so the mismatch is obvious.
    expect(posts[0].body.text).toContain('Max Ma');
    expect(posts[0].body.text).not.toMatch(/What do you want to say/);
  });

  it('opens the reply when the card and the resolved row agree', async () => {
    const tracked = createTrackedHandlers();
    server.use(...digestLookupHandlers({ item: DIGEST_ITEM }), ...tracked.handlers);

    const result = await handleEmailInteraction(
      buildDigestPayload({
        itemNumber: 3,
        text: '*🌅 Morning Digest*\n[#3] Scott Sanborn (Alliance Laundry) — quote ready for signature',
      })
    );

    expect(result.result.success).toBe(true);
    expect(tracked.calls.filter(c => c.type === 'post')[0].body.text).toMatch(/What do you want to say/);
  });

  it('reports a helpful error when the digest item cannot be resolved', async () => {
    const tracked = createTrackedHandlers();
    server.use(...digestLookupHandlers({ item: null }), ...tracked.handlers);

    const result = await handleEmailInteraction(buildDigestPayload({ itemNumber: 9 }));

    expect(result.result.success).toBe(false);
    const posts = tracked.calls.filter(c => c.type === 'post');
    expect(posts).toHaveLength(1);
    expect(posts[0].body.text).toMatch(/#9/);
  });

  it('rejects a click from anyone other than the approver without touching the database', async () => {
    const tracked = createTrackedHandlers();
    server.use(...tracked.handlers);

    const result = await handleEmailInteraction(buildDigestPayload({ userId: 'U_SOMEONE_ELSE' }));

    expect(result.result.success).toBe(false);
    expect(tracked.calls).toHaveLength(1);
    expect(tracked.calls[0].body.text).toContain('U_SOMEONE_ELSE');
  });

  it('ignores a click from the wrong channel with zero calls', async () => {
    const tracked = createTrackedHandlers();
    server.use(...tracked.handlers);

    const result = await handleEmailInteraction(buildDigestPayload({ channelId: 'C_WRONG' }));

    expect(result.handled).toBe(false);
    expect(tracked.calls).toHaveLength(0);
  });
});

describe('handleInteraction routing', () => {
  it('routes email_* actions to the email handler', async () => {
    const tracked = createTrackedHandlers();
    server.use(...digestLookupHandlers({ item: DIGEST_ITEM }), ...tracked.handlers);

    const result = await handleInteraction(buildDigestPayload());

    expect(result.handled).toBe(true);
    expect(result.action).toBe(`${EMAIL_ACTIONS.REPLY}_3`);
    expect(tracked.calls.filter(c => c.type === 'post')[0].body.text).toContain('Scott Sanborn');
  });

  it('routes calendar_* actions to the calendar handler', async () => {
    const store = createDraftStore(pendingDraft({ id: 'draft-routed' }));
    const tracked = createTrackedHandlers();
    server.use(...store.handlers, ...tracked.handlers);

    const result = await handleInteraction(
      buildPayload({ actionId: CALENDAR_ACTIONS.DISCARD, draftId: 'draft-routed' })
    );

    expect(result.handled).toBe(true);
    expect(store.current.status).toBe('discarded');
  });
});

describe('handleCalendarInteraction: guards', () => {
  it('ignores a click from the wrong channel with zero calls', async () => {
    const tracked = createTrackedHandlers();
    server.use(...tracked.handlers);

    const payload = buildPayload({ actionId: CALENDAR_ACTIONS.APPLY, draftId: 'draft-x', channelId: 'C_WRONG' });
    const result = await handleCalendarInteraction(payload);

    expect(result.handled).toBe(false);
    expect(tracked.calls).toHaveLength(0);
  });

  it('ignores an unknown (non-calendar_*) action_id with zero calls', async () => {
    const tracked = createTrackedHandlers();
    server.use(...tracked.handlers);

    const payload = buildPayload({ actionId: 'email_apply', draftId: 'draft-x' });
    const result = await handleCalendarInteraction(payload);

    expect(result.handled).toBe(false);
    expect(tracked.calls).toHaveLength(0);
  });

  it('rejects a click from anyone other than the approver, posting one notice and writing nothing', async () => {
    const store = createDraftStore(pendingDraft({ id: 'draft-unauth' }));
    const tracked = createTrackedHandlers();
    server.use(...store.handlers, ...tracked.handlers);

    const payload = buildPayload({
      actionId: CALENDAR_ACTIONS.APPLY,
      draftId: 'draft-unauth',
      userId: 'U_SOMEONE_ELSE',
    });
    const result = await handleCalendarInteraction(payload);

    expect(result.handled).toBe(true);
    expect(result.result.success).toBe(false);
    expect(tracked.calls).toHaveLength(1);
    expect(tracked.calls[0].type).toBe('post');
    expect(tracked.calls[0].body.text).toContain('U_SOMEONE_ELSE');
    expect(store.current.status).toBe('pending');
  });
});
