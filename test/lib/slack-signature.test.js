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
