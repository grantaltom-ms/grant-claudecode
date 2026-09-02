import { http, HttpResponse } from 'msw';

// ─── Microsoft Graph ────────────────────────────────────────────────────────

export const graphTokenHandler = http.post(
  'https://login.microsoftonline.com/:tenant/oauth2/v2.0/token',
  () => HttpResponse.json({ access_token: 'test-graph-token', expires_in: 3600 })
);

// Default: no messages. Override per-test with server.use(graphMessagesHandler(emails)).
export function graphMessagesHandler(emails = []) {
  return http.get('https://graph.microsoft.com/v1.0/users/:email/mailFolders/:folder/messages', () =>
    HttpResponse.json({ value: emails })
  );
}

export const graphMessageGetHandler = http.get(
  'https://graph.microsoft.com/v1.0/users/:email/messages/:id',
  () => HttpResponse.json({ id: 'test-message-id', subject: 'Test', body: { content: '', contentType: 'text' } })
);

export const graphMoveHandler = http.post(
  'https://graph.microsoft.com/v1.0/users/:email/messages/:id/move',
  () => HttpResponse.json({ id: 'archived-message-id' })
);

export const graphSendHandler = http.post(
  'https://graph.microsoft.com/v1.0/users/:email/messages/:id/send',
  () => new HttpResponse(null, { status: 202 })
);

export const graphCreateReplyHandler = http.post(
  'https://graph.microsoft.com/v1.0/users/:email/messages/:id/createReply',
  () => HttpResponse.json({ id: 'test-draft-id' })
);

export const graphAttachmentsHandler = http.get(
  'https://graph.microsoft.com/v1.0/users/:email/messages/:id/attachments',
  () => HttpResponse.json({ value: [] })
);

// ─── Anthropic ──────────────────────────────────────────────────────────────
//
// One smart-router handler serves every call site in the codebase by
// inspecting the request's `system` prompt, since each site's system prompt
// is distinctive enough to identify. Override with server.use(...) in
// individual tests when a specific canned response is needed (e.g. the
// Comply bot's multi-turn tool-use loop).

function textResponse(text) {
  return HttpResponse.json({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
  });
}

export const anthropicDefaultHandler = http.post('https://api.anthropic.com/v1/messages', async ({ request }) => {
  const body = await request.json();
  const system = typeof body.system === 'string' ? body.system : (body.system?.[0]?.text || '');

  if (system.includes('spam filter')) {
    return textResponse('[]');
  }
  if (system.includes('Extract durable business entities')) {
    return textResponse('[]');
  }
  if (system.includes('summarize business email threads') || system.includes('durable memory')) {
    return textResponse(JSON.stringify({ current_summary: 'Test thread summary.', open_items: [], status: 'active' }));
  }
  if (system.includes('morning email triage assistant')) {
    return textResponse('*🌅 Morning Digest — Test Day*\n\n*🔴 Action Required*\n- [#1] Test Sender — Test Subject: needs a reply\n\n1 emails total — 1 need action');
  }
  if (system.includes('extract durable operating memory')) {
    return textResponse(JSON.stringify({ decisions: [], commitments: [], open_loops: [] }));
  }
  if (system.includes('weekday One Priority')) {
    return textResponse(JSON.stringify({ title: 'Test priority', activity: 'Do the test thing', why_this_matters: 'because tests' }));
  }
  if (system.includes('email and calendar assistant for Grant Carlson')) {
    return textResponse('Sure, here is a summary.');
  }
  if (system.includes('Lease Compliance Assistant')) {
    return textResponse('What is the property and unit number?\n\nAPPROVE_OR_REVISE');
  }

  return textResponse('(unhandled system prompt in test mock -- override with server.use())');
});

export function anthropicToolUseHandler(toolName, input, { id = 'toolu_test' } = {}) {
  return http.post('https://api.anthropic.com/v1/messages', () =>
    HttpResponse.json({
      id: 'msg_test_tool_use',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: toolName, input }],
      stop_reason: 'tool_use',
    })
  );
}

export function anthropicTextHandler(text) {
  return http.post('https://api.anthropic.com/v1/messages', () => textResponse(text));
}

// ─── Slack ──────────────────────────────────────────────────────────────────

export const slackPostMessageHandler = http.post('https://slack.com/api/chat.postMessage', () =>
  HttpResponse.json({ ok: true, ts: '1700000000.000001' })
);

export const slackUpdateHandler = http.post('https://slack.com/api/chat.update', () =>
  HttpResponse.json({ ok: true })
);

export const slackRepliesHandler = http.get('https://slack.com/api/conversations.replies', () =>
  HttpResponse.json({ ok: true, messages: [] })
);

export const slackAuthTestHandler = http.get('https://slack.com/api/auth.test', () =>
  HttpResponse.json({ ok: true, user_id: 'UTESTBOT' })
);

// ─── OpenAI ─────────────────────────────────────────────────────────────────

export const openaiEmbeddingsHandler = http.post('https://api.openai.com/v1/embeddings', () =>
  HttpResponse.json({ data: [{ embedding: new Array(1536).fill(0.001) }] })
);

// ─── Supabase (PostgREST) ───────────────────────────────────────────────────
//
// Generic catch-all: writes (insert/upsert/update) succeed with an empty
// array (PostgREST's shape for a write with no `.select()`), and selects/RPCs
// return an empty array unless a test overrides with a more specific handler
// registered ahead of this one via server.use().

export const supabaseWriteHandler = http.all('https://test-project.supabase.co/rest/v1/:table', () =>
  HttpResponse.json([])
);

export const supabaseRpcHandler = http.post('https://test-project.supabase.co/rest/v1/rpc/:fn', () =>
  HttpResponse.json([])
);

export const handlers = [
  graphTokenHandler,
  graphMessagesHandler([]),
  graphMessageGetHandler,
  graphMoveHandler,
  graphSendHandler,
  graphCreateReplyHandler,
  graphAttachmentsHandler,
  anthropicDefaultHandler,
  slackPostMessageHandler,
  slackUpdateHandler,
  slackRepliesHandler,
  slackAuthTestHandler,
  openaiEmbeddingsHandler,
  supabaseRpcHandler,
  supabaseWriteHandler,
];
