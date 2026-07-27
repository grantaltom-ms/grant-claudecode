// lib/slack.js
// Shared Slack posting helpers. The bot token is passed in explicitly rather
// than read from a single fixed env var, because this repo runs two separate
// Slack apps (the inbox-digest bot on SLACK_BOT_TOKEN, the Comply-or-Vacate
// bot on COMPLY_SLACK_BOT_TOKEN) that must never share a token.

import { withRetry } from './retry';

// Slack returns API-level errors (e.g. `ratelimited`) as HTTP 200 with
// `{ok: false, ...}`, not as a non-2xx status -- capture res.status and any
// Retry-After header onto the thrown error so withRetry can tell a real rate
// limit (retryable) apart from e.g. `invalid_auth` (not retryable).
function slackApiError(message, res) {
  const err = new Error(message);
  err.status = res.status === 200 ? 429 : res.status;
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) err.retryAfterMs = Number(retryAfter) * 1000;
  return err;
}

async function slackPostOnce(token, channel, text, threadTs, blocks) {
  const body = { channel, text };
  if (threadTs) body.thread_ts = threadTs;
  if (blocks) body.blocks = blocks;

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json();

  if (!data.ok && data.error === 'invalid_blocks' && blocks) {
    console.error('slackPost invalid blocks, retrying without blocks:', {
      channel,
      threadTs,
      textLength: text?.length,
      blockCount: blocks.length,
    });
    return slackPostOnce(token, channel, text, threadTs, null);
  }
  if (!data.ok) {
    console.error('slackPost error:', data.error, { channel, threadTs, textLength: text?.length });
    if (data.error === 'ratelimited') throw slackApiError(`Slack post failed: ${data.error}`, res);
    throw new Error(`Slack post failed: ${data.error}`);
  }
  return data;
}

export async function slackPost(token, channel, text, threadTs = null, blocks = null) {
  return withRetry(() => slackPostOnce(token, channel, text, threadTs, blocks), { label: 'slack chat.postMessage' });
}

// Update an existing Slack message (used to collapse interactive buttons after click).
async function slackUpdateMessageOnce(token, channel, ts, text, blocks) {
  const body = { channel, ts, text, blocks: blocks || [] };
  const res = await fetch('https://slack.com/api/chat.update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error('slackUpdateMessage error:', data.error);
    if (data.error === 'ratelimited') throw slackApiError(`Slack update failed: ${data.error}`, res);
  }
  return data;
}

export async function slackUpdateMessage(token, channel, ts, text, blocks = null) {
  try {
    return await withRetry(() => slackUpdateMessageOnce(token, channel, ts, text, blocks), { label: 'slack chat.update' });
  } catch (err) {
    // Preserve the original never-throws contract even once retries are
    // exhausted -- an update that never lands just leaves stale buttons up,
    // not a correctness problem worth propagating as an exception.
    console.error('slackUpdateMessage failed after retries:', err.message);
    return { ok: false, error: err.message };
  }
}

export async function getThreadHistory(token, channel, threadTs, limit = 50) {
  return withRetry(async () => {
    const res = await fetch(
      `https://slack.com/api/conversations.replies?channel=${channel}&ts=${threadTs}&limit=${limit}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    return data.messages || [];
  }, { label: 'slack conversations.replies' });
}

export async function getBotUserId(token) {
  return withRetry(async () => {
    const res = await fetch('https://slack.com/api/auth.test', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    return data.user_id;
  }, { label: 'slack auth.test' });
}

// 3-step external file upload flow, generalized from lib/comply-agent.js's
// PDF upload (channel is now a parameter rather than hardcoded to the Comply
// bot's channel, so this can be reused by other bots). Deliberately NOT
// wrapped in withRetry: completeUploadExternal has a durable effect (posting
// the file to the channel/thread), and the same ambiguous-network-error
// concern that applies to Graph's send/move calls applies here too --
// retrying blindly risks posting the same PDF twice.
export async function uploadFileToSlack(token, channelId, fileBuffer, filename, threadTs) {
  const urlParams = new URLSearchParams({ filename, length: String(fileBuffer.length) });
  const urlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${token}` },
    body: urlParams.toString(),
  });
  const urlData = await urlRes.json();
  if (!urlData.ok) throw new Error(`files.getUploadURLExternal failed: ${urlData.error}`);

  const uploadRes = await fetch(urlData.upload_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: fileBuffer,
  });
  if (!uploadRes.ok) throw new Error(`File upload failed: ${uploadRes.status}`);

  const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      files: [{ id: urlData.file_id }],
      channel_id: channelId,
      thread_ts: threadTs,
    }),
  });
  const completeData = await completeRes.json();
  if (!completeData.ok) throw new Error(`files.completeUploadExternal failed: ${completeData.error}`);
  return completeData;
}
