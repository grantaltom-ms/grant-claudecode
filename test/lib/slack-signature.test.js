import crypto from 'crypto';
import { describe, it, expect } from 'vitest';
import { verifySlackSignature as complyVerify } from '../../lib/comply-agent';
import { verifySlackSignature as inboxVerify } from '../../pages/api/inbox-assistant';

function sign(secret, timestamp, rawBody) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`v0:${timestamp}:${rawBody}`);
  return `v0=${hmac.digest('hex')}`;
}

// comply-agent.js's verifySlackSignature(req, rawBody) reads the signature off req.headers
// and always checks against COMPLY_SLACK_SIGNING_SECRET.
describe('lib/comply-agent verifySlackSignature', () => {
  const secret = process.env.COMPLY_SLACK_SIGNING_SECRET;
  const rawBody = 'payload=test';

  function reqWith(timestamp, signature) {
    return { headers: { 'x-slack-request-timestamp': String(timestamp), 'x-slack-signature': signature } };
  }

  it('passes for a validly signed request', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = sign(secret, timestamp, rawBody);
    expect(complyVerify(reqWith(timestamp, signature), rawBody)).toBe(true);
  });

  it('fails for a tampered body', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = sign(secret, timestamp, rawBody);
    expect(complyVerify(reqWith(timestamp, signature), 'payload=tampered')).toBe(false);
  });

  it('fails when the timestamp is older than 5 minutes (replay protection)', () => {
    const timestamp = Math.floor(Date.now() / 1000) - 301;
    const signature = sign(secret, timestamp, rawBody);
    expect(complyVerify(reqWith(timestamp, signature), rawBody)).toBe(false);
  });

  it('does not throw on malformed input (missing headers)', () => {
    expect(() => complyVerify({ headers: {} }, rawBody)).not.toThrow();
    expect(complyVerify({ headers: {} }, rawBody)).toBe(false);
  });

  it('does not throw when the signature header is not comparable to the computed one', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    expect(() => complyVerify(reqWith(timestamp, 'v0=not-even-hex-length-matched'), rawBody)).not.toThrow();
  });
});

// inbox-assistant.js's verifySlackSignature(rawBody, headers) has the same algorithm but a
// different parameter order and checks against the inbox bot's own SLACK_SIGNING_SECRET.
describe('inbox-assistant verifySlackSignature', () => {
  const secret = process.env.SLACK_SIGNING_SECRET;
  const rawBody = 'payload=test';

  function headersWith(timestamp, signature) {
    return { 'x-slack-request-timestamp': String(timestamp), 'x-slack-signature': signature };
  }

  it('passes for a validly signed request', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = sign(secret, timestamp, rawBody);
    expect(inboxVerify(rawBody, headersWith(timestamp, signature))).toBe(true);
  });

  it('fails for a tampered body', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = sign(secret, timestamp, rawBody);
    expect(inboxVerify('payload=tampered', headersWith(timestamp, signature))).toBe(false);
  });

  it('fails when the timestamp is older than 5 minutes (replay protection)', () => {
    const timestamp = Math.floor(Date.now() / 1000) - 301;
    const signature = sign(secret, timestamp, rawBody);
    expect(inboxVerify(rawBody, headersWith(timestamp, signature))).toBe(false);
  });

  it('does not throw on malformed input (missing headers)', () => {
    expect(() => inboxVerify(rawBody, {})).not.toThrow();
    expect(inboxVerify(rawBody, {})).toBe(false);
  });
});

// Regression: comply-vacate.js used to verify against JSON.stringify(req.body) instead of the
// bytes Slack sent. Slack escapes some non-ASCII characters that V8 emits literally, so any
// message containing one — an em dash, for instance — failed verification and was silently
// dropped with no reply in the thread.
describe('signature verification against re-serialized JSON', () => {
  const secret = process.env.COMPLY_SLACK_SIGNING_SECRET;

  // What Slack actually puts on the wire for an em dash.
  const slackRawBody = '{"event":{"text":"pet was not approved \\u2014 see lease"}}';

  function reqWith(timestamp, signature) {
    return { headers: { 'x-slack-request-timestamp': String(timestamp), 'x-slack-signature': signature } };
  }

  it('re-serializing the parsed body changes the bytes Slack signed', () => {
    const reserialized = JSON.stringify(JSON.parse(slackRawBody));
    expect(reserialized).not.toBe(slackRawBody);
    expect(reserialized).toContain('—');
  });

  it('verifies the raw body but not the re-serialized one', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = sign(secret, timestamp, slackRawBody);

    expect(complyVerify(reqWith(timestamp, signature), slackRawBody)).toBe(true);
    expect(
      complyVerify(reqWith(timestamp, signature), JSON.stringify(JSON.parse(slackRawBody)))
    ).toBe(false);
  });
});
