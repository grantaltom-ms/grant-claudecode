import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import { CHANNEL_ID, APPROVER_USER_ID } from '../pages/api/inbox-assistant';
import { handleInteraction } from '../pages/api/inbox-interactions';
import { buildTodoBlocks, EMAIL_ACTIONS } from '../lib/inbox-blocks';

const ITEM = {
  id: 'item-7', item_number: 3, graph_message_id: 'msg-7', graph_conversation_id: 'conv-7',
  sender_name: 'Marla Branch', sender_email: 'marla@usi.com', subject: 'Vintage Tacoma supplemental app',
  received_at: '2026-09-28T16:00:00Z', action_status: 'open',
};

function record() {
  const calls = { updates: [], posts: [], patches: [] };
  server.use(
    http.get('https://test-project.supabase.co/rest/v1/digest_items', () => HttpResponse.json(ITEM)),
    http.patch('https://test-project.supabase.co/rest/v1/digest_items', async ({ request }) => {
      calls.patches.push(await request.json());
      return HttpResponse.json([]);
    }),
    http.post('https://slack.com/api/chat.update', async ({ request }) => {
      calls.updates.push(await request.json());
      return HttpResponse.json({ ok: true });
    }),
    http.post('https://slack.com/api/chat.postMessage', async ({ request }) => {
      calls.posts.push(await request.json());
      return HttpResponse.json({ ok: true, ts: '1.1' });
    })
  );
  return calls;
}

function clickPayload(prefix, userId = APPROVER_USER_ID) {
  const blocks = buildTodoBlocks('*Morning Digest*', [ITEM], [], []);
  const button = blocks.find((b) => b.type === 'actions').elements.find((e) => e.action_id.startsWith(prefix));
  return {
    type: 'block_actions',
    user: { id: userId },
    channel: { id: CHANNEL_ID },
    message: { ts: '100.1', text: '*Morning Digest*', blocks },
    actions: [button],
  };
}

describe('to-do buttons in Slack', () => {
  it('✅ Done marks the item done and swaps its buttons for the outcome', async () => {
    const calls = record();
    const result = await handleInteraction(clickPayload(EMAIL_ACTIONS.DONE));
    expect(result.result.success).toBe(true);
    expect(calls.patches[0]).toMatchObject({ action_status: 'done' });
    const updated = calls.updates[0].blocks.find((b) => b.block_id === 'todo_item-7');
    expect(updated.type).toBe('context');
    expect(updated.elements[0].text).toContain('✅ Done — Marla Branch');
  });

  it('💤 Tomorrow snoozes to a date, not a status that never comes back', async () => {
    const calls = record();
    await handleInteraction(clickPayload(EMAIL_ACTIONS.SNOOZE));
    expect(calls.patches[0].action_status).toBe('snoozed');
    expect(calls.patches[0].snoozed_until).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('✍️ Reply on a to-do row opens the reply for that exact email', async () => {
    const calls = record();
    await handleInteraction(clickPayload(EMAIL_ACTIONS.REPLY));
    expect(calls.posts[0].text).toContain('Reply to Marla Branch — Vintage Tacoma supplemental app');
    expect(calls.posts[0].thread_ts).toBe('100.1');
  });

  it('ignores clicks from anyone but Grant and changes nothing', async () => {
    const calls = record();
    const result = await handleInteraction(clickPayload(EMAIL_ACTIONS.DONE, 'USOMEONEELSE'));
    expect(result.result.success).toBe(false);
    expect(calls.patches).toHaveLength(0);
    expect(calls.posts[0].text).toContain('Ignored a button click');
  });
});
