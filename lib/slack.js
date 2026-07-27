// lib/slack.js
// Shared Slack posting helpers. The bot token is passed in explicitly rather
// than read from a single fixed env var, because this repo runs two separate
// Slack apps (the inbox-digest bot on SLACK_BOT_TOKEN, the Comply-or-Vacate
// bot on COMPLY_SLACK_BOT_TOKEN) that must never share a token.

export async function slackPost(token, channel, text, threadTs = null, blocks = null) {
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
    return slackPost(token, channel, text, threadTs, null);
  }
  if (!data.ok) {
    console.error('slackPost error:', data.error, { channel, threadTs, textLength: text?.length });
    throw new Error(`Slack post failed: ${data.error}`);
  }
  return data;
}

// Update an existing Slack message (used to collapse interactive buttons after click).
export async function slackUpdateMessage(token, channel, ts, text, blocks = null) {
  const body = { channel, ts, text, blocks: blocks || [] };
  const res = await fetch('https://slack.com/api/chat.update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) console.error('slackUpdateMessage error:', data.error);
  return data;
}

export async function getThreadHistory(token, channel, threadTs, limit = 50) {
  const res = await fetch(
    `https://slack.com/api/conversations.replies?channel=${channel}&ts=${threadTs}&limit=${limit}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return data.messages || [];
}

export async function getBotUserId(token) {
  const res = await fetch('https://slack.com/api/auth.test', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.user_id;
}

// 3-step external file upload flow, generalized from lib/comply-agent.js's
// PDF upload (channel is now a parameter rather than hardcoded to the Comply
// bot's channel, so this can be reused by other bots).
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
