# Inbox Assistant — Setup Guide

## What this does
- Listens for messages in Slack #inbox-digest (C0AS84GA607)
- When you post a request (e.g. "draft a reply to the BECU email"), Claude fetches your Outlook email and responds in-thread
- Drafts are presented for your approval — nothing is sent without you saying so

## Prerequisites
- [ ] Zapier MCP URL (from zapier.com/app/mcp)
- [ ] Zapier account connected to Microsoft Outlook and Slack
- [ ] Anthropic API key
- [ ] Slack app signing secret + bot token (from your existing "Delinquency Manager" app A0AGXH1MG0N)

---

## Step 1 — Deploy to Vercel

```bash
cd inbox-assistant
npm install
npx vercel --prod
```

Note the deployment URL (e.g. `https://inbox-assistant-xyz.vercel.app`).

## Step 2 — Add environment variables in Vercel

In your Vercel project dashboard → Settings → Environment Variables, add:

| Variable | Where to find it |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `SLACK_BOT_TOKEN` | api.slack.com → Your Apps → Delinquency Manager → OAuth & Permissions |
| `SLACK_SIGNING_SECRET` | api.slack.com → Your Apps → Delinquency Manager → Basic Information |
| `ZAPIER_MCP_URL` | zapier.com/app/mcp → your server → copy the MCP URL |

## Step 3 — Configure the Slack app to receive events

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Delinquency Manager** (A0AGXH1MG0N)
2. **Event Subscriptions** → Enable Events → set Request URL to:
   ```
   https://your-vercel-url.vercel.app/api/inbox-assistant
   ```
   Slack will send a verification challenge — the function handles this automatically.
3. Under **Subscribe to bot events**, add:
   - `message.channels`
4. Save changes and **reinstall the app** to your workspace if prompted.

## Step 4 — Invite the bot to #inbox-digest

In Slack, go to #inbox-digest and run:
```
/invite @DelinquencyManager
```
(or whatever the bot's display name is)

## Step 5 — Test it

Post a message in #inbox-digest:
```
What emails need my attention today?
```

Claude will reply in-thread within a few seconds.

---

## Example requests

- `What needs my attention today?`
- `Draft a reply to the BECU financial documents email`
- `Summarize the thread with Rhoda about the 1099s`
- `Has Shannon at Psomas followed up about the W-9?`
- `Flag the stolen rents email from Rhoda as urgent`

---

## Scheduled morning digest (Option B)

Once you've added the Zapier MCP connector at claude.ai/settings/connectors, come back to Claude Code and say "set up the 7am digest" — that creates a separate scheduled agent that posts a triage summary to #inbox-digest every morning at 7am PT.
