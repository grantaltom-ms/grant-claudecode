import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import { executeTool } from '../pages/api/inbox-assistant';

const TOKEN = 'test-graph-token';

describe('inbox-assistant pre-send mail tips wiring', () => {
  it('create_new_draft surfaces mail_tip_warnings for an out-of-office recipient', async () => {
    server.use(
      http.post('https://graph.microsoft.com/v1.0/users/:email/messages', () =>
        HttpResponse.json({ id: 'draft-1', subject: 'Hello' })
      ),
      http.post('https://graph.microsoft.com/v1.0/users/:email/getMailTips', () =>
        HttpResponse.json({
          value: [{
            emailAddress: { address: 'lender@becu.org' },
            automaticReplies: { message: 'Out of the office until Monday.' },
          }],
        })
      )
    );

    const result = await executeTool('create_new_draft', {
      to: ['lender@becu.org'],
      subject: 'Hello',
      body: 'Hi there',
    }, TOKEN, 'thread-ts');

    expect(result.mail_tip_warnings).toEqual([
      'lender@becu.org has an out-of-office reply active: "Out of the office until Monday."',
    ]);
  });

  it('create_new_draft omits mail_tip_warnings for a clean recipient', async () => {
    server.use(
      http.post('https://graph.microsoft.com/v1.0/users/:email/messages', () =>
        HttpResponse.json({ id: 'draft-2', subject: 'Hello' })
      ),
      http.post('https://graph.microsoft.com/v1.0/users/:email/getMailTips', () =>
        HttpResponse.json({ value: [{ emailAddress: { address: 'lender@becu.org' } }] })
      )
    );

    const result = await executeTool('create_new_draft', {
      to: ['lender@becu.org'],
      subject: 'Hello',
      body: 'Hi there',
    }, TOKEN, 'thread-ts');

    expect(result.mail_tip_warnings).toBeUndefined();
  });

  it('create_draft_reply surfaces mail_tip_warnings for the original sender', async () => {
    server.use(
      http.get('https://graph.microsoft.com/v1.0/users/:email/messages/:id', () =>
        HttpResponse.json({
          from: { emailAddress: { address: 'crystal.li@becu.org' } },
          ccRecipients: [],
        })
      ),
      http.post('https://graph.microsoft.com/v1.0/users/:email/getMailTips', () =>
        HttpResponse.json({
          value: [{ emailAddress: { address: 'crystal.li@becu.org' }, mailboxFull: true }],
        })
      )
    );

    const result = await executeTool('create_draft_reply', {
      message_id: 'msg-1',
      body: 'Thanks!',
    }, TOKEN, 'thread-ts');

    expect(result.mail_tip_warnings).toEqual(["crystal.li@becu.org's mailbox appears full"]);
  });

  it('still creates the draft when the getMailTips call fails', async () => {
    server.use(
      http.post('https://graph.microsoft.com/v1.0/users/:email/messages', () =>
        HttpResponse.json({ id: 'draft-3', subject: 'Hello' })
      ),
      http.post('https://graph.microsoft.com/v1.0/users/:email/getMailTips', () =>
        HttpResponse.json({ error: { message: 'Forbidden' } }, { status: 403 })
      )
    );

    const result = await executeTool('create_new_draft', {
      to: ['lender@becu.org'],
      subject: 'Hello',
      body: 'Hi there',
    }, TOKEN, 'thread-ts');

    expect(result.draft_id).toBe('draft-3');
    expect(result.mail_tip_warnings).toBeUndefined();
  });
});
