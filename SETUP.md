# Inbox Assistant — Setup Guide

_Last verified against code: 2026-07-27._

## What this does

Inbox Assistant is a Next.js app deployed to Vercel that runs three things for Grant Carlson at Milestone Properties:

1. **Interactive Slack bot** (`pages/api/inbox-assistant.js`) — post a message in `#inbox-digest` and Claude reads/searches/drafts/sends your Outlook mail through Microsoft Graph. Drafts require explicit approval before sending.
2. **Morning digest cron** (`pages/api/digest.js`) — triages the last 24 hours of inbox into priority buckets and posts to `#inbox-digest`.
3. **Memory pipeline** (`pages/api/backfill-*.js`, `memory-maintenance.js`) — ingests email into Supabase so the assistant has long-term context (entities, projects, commitments, open loops).

There's also a separate Comply-or-Vacate legal-notice bot (`pages/api/comply-vacate.js`) running in its own Slack channel with its own credentials — see `docs/inbox-memory-architecture.md` for that system.

**This system does not use Zapier.** It authenticates to Microsoft Graph directly with an Azure app registration (client-credentials flow, no user login). If you've seen an older version of this guide mention `ZAPIER_MCP_URL`, that's stale — ignore it.

## Prerequisites

- [ ] An Azure AD app registration with Microsoft Graph **application** permissions: `Mail.Read`, `Mail.ReadWrite`, `Mail.Send`, `MailboxSettings.Read`, `Calendars.ReadWrite`, `MailboxFolder.ReadWrite`, `MailboxItem.ImportExport` (application permissions, not delegated — delegated permissions will not work with this client-credentials flow). Admin consent must be granted after adding the permissions. See `docs/system-reference.md`'s "Azure App Registration" section for what each permission unlocks.
- [ ] A Supabase project with the migrations in `supabase/migrations/` applied, in order.
- [ ] An Anthropic API key.
- [ ] Two Slack apps: one for the inbox-digest bot, one for the Comply-or-Vacate bot (if you're using that feature). Each needs a bot token and signing secret.
- [ ] Vercel Pro (cron jobs require it).

## Step 1 — Deploy to Vercel

```bash
npm install
npx vercel --prod
```

Note the deployment URL (e.g. `https://your-app.vercel.app`).

## Step 2 — Set environment variables

In Vercel → your project → Settings → Environment Variables:

| Variable | Purpose | Required? |
|---|---|---|
| `ANTHROPIC_API_KEY` | All Claude agent loops (digest, interactive assistant, Comply bot, memory pipeline) | Yes |
| `AZURE_TENANT_ID` | Azure AD tenant for Graph auth | Yes |
| `AZURE_CLIENT_ID` | Azure app registration client ID | Yes |
| `AZURE_CLIENT_SECRET` | Azure app registration client secret | Yes |
| `SUPABASE_URL` | Supabase project URL (the memory pipeline's database) | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key — used by everything except the Comply bot | Yes |
| `SLACK_BOT_TOKEN` | Bot token for the inbox-digest Slack app (`xoxb-...`) | Yes |
| `SLACK_SIGNING_SECRET` | Signing secret for the same Slack app | Yes |
| `CRON_SECRET` | Shared bearer token for all cron and backfill endpoints — pick any long random string | Yes |
| `COMPLY_SLACK_BOT_TOKEN` | Bot token for the separate Comply-or-Vacate Slack app | Only if using the Comply bot |
| `COMPLY_SLACK_SIGNING_SECRET` | Signing secret for the Comply-or-Vacate Slack app | Only if using the Comply bot |
| `VERCEL_TOKEN` | Vercel API token — lets the assistant save triage rules it learns from you via its own deployment's env vars | Only if you want `update_triage_rules` to work |
| `TRIAGE_RULES` | JSON array of custom triage rules, e.g. `["Emails from Crystal Li are always Action Required"]` — the bot manages this itself once `VERCEL_TOKEN` is set | Optional, bot-managed |
| `OPENAI_API_KEY` | Embeddings for semantic memory search — without it the system falls back to keyword-only search | Optional |
| `EMBEDDING_MODEL` | Defaults to `text-embedding-3-small` | Optional |
| `AUTO_ARCHIVE_SPAM` | Set to the string `true` to have the digest actually archive detected spam. Any other value (or unset) filters spam out of the digest without touching the Inbox. | Optional |
| `OWNER_INVESTOR_SUPABASE_URL` / `OWNER_INVESTOR_SUPABASE_SERVICE_ROLE_KEY` | Only needed if syncing owner/investor data from a separate Supabase project (`backfill-owner-investors.js`) | Optional |
| `SOURCE_MEMORY_SUPABASE_URL` / `SOURCE_MEMORY_SUPABASE_SERVICE_ROLE_KEY` | Only needed if syncing properties/team/schedule data from a separate Supabase project (`backfill-source-memory.js`) | Optional |
| `INBOX_ASSISTANT_URL` | Only used by `scripts/smoke-memory-status.mjs` when run manually | Optional |
| `SLACK_APPROVER_USER_ID` | Slack user ID allowed to click calendar approval buttons (`pages/api/inbox-interactions.js`). Defaults to Grant's own ID if unset. | Optional |

> **Note on the Comply bot's Supabase variable name.** `lib/comply-agent.js` reads `SUPABASE_SERVICE_KEY` first and falls back to `SUPABASE_SERVICE_ROLE_KEY` if that's not set. In practice, just setting `SUPABASE_SERVICE_ROLE_KEY` (the variable every other file uses) is enough — you don't need to set both.

## Step 3 — Configure the Slack app to receive events

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → your inbox-digest app.
2. **Event Subscriptions** → Enable Events → Request URL:
   ```
   https://your-vercel-url.vercel.app/api/inbox-assistant
   ```
   Slack sends a verification challenge — the endpoint handles it automatically.
3. Under **Subscribe to bot events**, add `message.channels` (and `message.groups` if the channel is private).
4. Also enable **Interactivity & Shortcuts** with Request URL `.../api/inbox-interactions` (that endpoint handles the calendar ✅ Book it / ✏️ Edit / 🗑️ Discard button clicks). No additional scopes needed — `chat:write` already covers it.
5. Save and reinstall the app to your workspace if prompted.

If you're also running the Comply-or-Vacate bot, repeat this against its own Slack app with Request URL `.../api/comply-vacate`, and additionally enable **Interactivity & Shortcuts** with Request URL `.../api/comply-interactions` (that endpoint handles the Approve / Request changes button clicks).

## Step 4 — Invite the bot to its channel

```
/invite @YourBotName
```

## Step 5 — Test it

Post in the channel:
```
What emails need my attention today?
```

The bot replies in-thread within a few seconds.

## Cron schedule

Set in `vercel.json`. Vercel Cron runs on UTC, which is worth knowing because these times shift by an hour at daylight saving:

| Job | UTC schedule | Pacific time (PDT, summer) | Pacific time (PST, winter) |
|---|---|---|---|
| `/api/digest` | `0 18 * * *` | 11:00 AM | 10:00 AM |
| `/api/memory-maintenance` | `0 19 * * *` | 12:00 PM | 11:00 AM |
| `/api/weekday-one-priority` | `0 16 * * 1-5` | 9:00 AM (weekdays) | 8:00 AM (weekdays) |

If you want the digest at a specific Pacific time year-round, you'll need to update the UTC expression twice a year, or accept the hour drift.

To trigger any cron endpoint manually:
```bash
curl -X POST https://your-vercel-url.vercel.app/api/digest \
  -H "Authorization: Bearer $CRON_SECRET"
```

## Example requests to the interactive assistant

- `What needs my attention today?`
- `Draft a reply to the BECU financial documents email`
- `Summarize the thread with Rhoda about the 1099s`
- `Has Shannon at Psomas followed up about the W-9?`
- `Flag the stolen rents email from Rhoda as urgent`

## Further reading

- `docs/system-reference.md` — full system reference, voice/style guide the assistant uses when drafting
- `docs/inbox-memory-architecture.md` — how the memory pipeline layers raw email into searchable context
- `docs/todoist-agent-instructions.md` — the separate Todoist task-creation routine (not part of this codebase)
