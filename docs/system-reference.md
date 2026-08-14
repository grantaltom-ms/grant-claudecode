# Milestone Properties — AI Inbox Assistant
## System Reference Document

> Upload this file to a Claude project to give Claude full context on how this system is built, what it does, and how to extend or debug it.

_Last verified against code: 2026-07-27._

---

## What This System Does

This is a fully custom AI email assistant for Grant Carlson (grant@milestoneproperties.net) at Milestone Properties. It has three parts:

1. **Morning Digest** — a Vercel Cron job (`0 18 * * *` UTC — 11:00 AM PDT / 10:00 AM PST, see "Cron Schedule" below) that reads the last 24 hours of email, filters spam, triages the rest into priority categories, and posts a structured summary to the Slack channel #inbox-digest.

2. **Interactive Assistant** — Grant can message the bot directly in #inbox-digest at any time. The bot can read, search, summarize, and draft emails, then send them after Grant explicitly approves.

3. **Memory pipeline** — a set of Supabase-backed backfill and maintenance endpoints (`pages/api/backfill-*.js`, `memory-maintenance.js`) that ingest email into a layered memory system (entities, thread summaries, projects, commitments, open loops) so the assistant has context beyond a single conversation. See `docs/inbox-memory-architecture.md` for the full design.

Everything lives in a single Next.js project deployed on Vercel. The system is backed by Supabase (Postgres + pgvector) — it is **not** stateless; there are 15 numbered migrations under `supabase/migrations/` and 18+ tables tracking email, memory, and operational state.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Vercel Serverless Functions (Node.js) |
| Framework | Next.js 14 (Pages Router) |
| Email source | Microsoft 365 Outlook via Microsoft Graph API |
| AI | Anthropic Claude (claude-sonnet-4-6) |
| Interface | Slack (Bot in #inbox-digest, channel ID: C0AS84GA607) |
| Scheduling | Vercel Cron (Pro plan required) |
| Background tasks | `@vercel/functions` `waitUntil` |

---

## Project Structure

```
inbox-assistant/
├── pages/
│   └── api/
│       ├── inbox-assistant.js   # Slack webhook + interactive agent
│       └── digest.js            # Morning digest cron handler
├── docs/
│   ├── system-reference.md      # This file
│   └── todoist-agent-instructions.md  # Instructions for Todoist routine agent
├── package.json
├── vercel.json                  # Function config + cron schedule
└── .env.example                 # Required environment variables
```

---

## Environment Variables

All secrets live in Vercel's environment variable settings. Never commit them to git.

See `SETUP.md` for the complete, verified environment variable table (it also covers the Supabase, OpenAI, Comply bot, and cross-project sync variables that aren't listed here). The short version:

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API access |
| `SLACK_BOT_TOKEN` | Slack bot posting (xoxb-...) |
| `SLACK_SIGNING_SECRET` | Vercel webhook signature verification |
| `AZURE_TENANT_ID` | Azure AD tenant ID for Graph auth |
| `AZURE_CLIENT_ID` | Azure app registration client ID |
| `AZURE_CLIENT_SECRET` | Azure app secret value (regenerate if compromised) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Supabase project powering the memory pipeline |
| `CRON_SECRET` | Shared secret for authenticating cron and backfill calls |
| `VERCEL_TOKEN` | Vercel API token — used by bot to save triage rules |
| `TRIAGE_RULES` | JSON array of custom triage rules (managed by bot) |
| `MAX_SENDS_PER_DAY` | Optional. Hard cap on `send_draft` calls per rolling 24h (default 25) — see "Send safety" below |
| `TRUSTED_DOMAINS` | Optional. Comma-separated domains exempt from the first-time-recipient flag (default `milestoneproperties.net`) |

Don't commit actual Azure tenant/client IDs, project IDs, or team IDs to this doc or any other file in the repo — reference them by variable name only. (This revision removes IDs that a previous version of this file had inlined directly.)

---

## Azure App Registration

**App:** registered in Azure Active Directory  
**Auth flow:** Client Credentials (no user login required — server-to-server)  
**Required Microsoft Graph Application Permissions:**
- `Mail.Read` — read inbox
- `Mail.ReadWrite` — create drafts, move/archive emails
- `Mail.Send` — send emails
- `MailboxSettings.Read` — pre-send mail tips (out-of-office, full mailbox, delivery restrictions) via `getMailTips`; without this, `getMailTips` calls fail and are silently skipped (mail tips are advisory and non-fatal by design — see "Pre-send mail tips" below)

Admin consent must be granted after adding permissions. Delegated permissions will NOT work — must be Application permissions.

---

## Slack App Configuration

**App name:** Bot Assistant  
**App ID:** A0AGXH1MG0N  
**Bot scopes required:**
- `chat:write` — post messages
- `channels:history` / `groups:history` — read channel messages
- `conversations.replies` — read thread history

**Event subscriptions:**
- `message.channels` — public channels
- `message.groups` — private channels (required — #inbox-digest is private)

**Request URL:** `https://inbox-assistant-one.vercel.app/api/inbox-assistant`

---

## Cron Schedule

Defined in `vercel.json`, which is the source of truth — see that file directly rather than trusting a copy pasted here. As of this revision there are three jobs:

| Job | UTC schedule | Pacific time (PDT) | Pacific time (PST) |
|---|---|---|---|
| `/api/digest` | `0 18 * * *` | 11:00 AM | 10:00 AM |
| `/api/memory-maintenance` | `0 19 * * *` | 12:00 PM | 11:00 AM |
| `/api/weekday-one-priority` | `0 16 * * 1-5` | 9:00 AM (weekdays) | 8:00 AM (weekdays) |

Vercel Cron runs on UTC with no daylight-saving adjustment, so each job's Pacific time shifts an hour twice a year. Cron requires a Vercel Pro plan. `vercel.json` also sets explicit `maxDuration` values per function under its `functions` block — check that file for current values, since digest and the backfill endpoints do enough sequential Claude/Graph work that they need more than Vercel's default timeout.

---

## File 1: `pages/api/inbox-assistant.js`

Handles all interactive Slack messages. When Grant sends a message in #inbox-digest, Slack POSTs to this endpoint.

### Flow

1. Verifies Slack signature (HMAC-SHA256)
2. Returns 200 immediately (Slack requires response within 3 seconds)
3. Uses `waitUntil` to keep the function alive for background processing
4. Posts "_On it..._" to the thread
5. Fetches thread history if Grant is replying in an existing thread (for context like "send it")
6. Runs the agentic loop: calls Claude with tools, executes tool calls, loops until Claude produces a final text response
7. Posts Claude's response back to the Slack thread

### Claude Tools Available to the Interactive Agent

| Tool | What it does |
|---|---|
| `list_emails` | Lists recent emails from Inbox, Sent, or Drafts. Supports unread filter. |
| `search_emails` | Searches by keyword across subject, body, sender. |
| `get_email` | Fetches full body + metadata of a specific email by ID. |
| `create_draft_reply` | Creates a reply draft. Automatically fetches and preserves CC recipients from original. Sends as HTML to maintain thread continuity. |
| `create_new_draft` | Creates a new outbound email to specified recipients. |
| `get_recent_drafts` | Retrieves most recent drafts — used to find the draft when Grant says "send it". |
| `send_draft` | Sends a saved draft. Only called after Grant explicitly approves. |
| `update_triage_rules` | Adds/removes/lists custom triage rules stored in Vercel env vars via Vercel API. |

### Key Implementation Details

**CC preservation on replies:**
`create_draft_reply` fetches `ccRecipients` from the original email, then calls Graph's `createReply` endpoint (which sets `conversationId` and reply headers) with the reply text passed directly as the `comment` field — converted to per-line `<div>` HTML so Outlook renders it correctly. This is a single call, not a create-then-PATCH sequence; CC recipients are preserved but the original body is not fetched or re-quoted.

**Send approval gate:**
There is no code-level approval gate — the system prompt explicitly prohibits sending without approval, and `send_draft` is an ordinary tool Claude can call at its own judgment. The entire safety boundary is the model correctly waiting for a phrase like "send it", "looks good", or "go ahead" before calling it. (See `docs/PLAN-tier1-2-reliability.md`, item 6, for a hardened design using Slack approval buttons — modeled on the pattern already used by the Comply-or-Vacate bot — that removes `send_draft` from the model's available tools entirely and requires a button click to actually send.)

**Send safety (`lib/send-safety.js`):**
Two independent checks, neither of which is the approval gate above — they exist underneath whatever calls Graph's send endpoint, today's `send_draft` handler:
- `checkSendRateLimit` — a hard backstop, not advisory. Before `send_draft` calls Graph, it counts rows in the `send_log` table (migration `021_send_log.sql`) for the last rolling 24h and refuses if `MAX_SENDS_PER_DAY` (default 25) is reached; `recordSend` logs every actual send afterward. This exists to bound the damage of a runaway loop or a bad approval, not to restrict who Grant can email.
- `flagNewRecipients` — advisory only, never blocks. `create_draft_reply` and `create_new_draft` check each recipient against `TRUSTED_DOMAINS` and this mailbox's saved `email_messages` history (as sender, To, or Cc); anything neither trusted nor previously seen comes back as `first_time_recipients` in the tool result, and the system prompt tells Claude to mention it when showing the draft. A strict allowlist was deliberately not used here — Grant emails new tenants/vendors as normal business, so blocking unknown recipients would break real usage.

**Pre-send mail tips (`lib/graph.js`'s `getMailTips`/`summarizeMailTips`):**
`create_draft_reply` and `create_new_draft` call Graph's `getMailTips` for the draft's recipients (out-of-office replies, full mailbox, delivery restrictions) and return any findings as `mail_tip_warnings` on the tool result; the system prompt tells Claude to mention them when showing the draft. Advisory only — wrapped in try/catch so a failed or unsupported mail tips call (e.g. missing `MailboxSettings.Read`, or an external domain that doesn't expose mail tips) never blocks drafting.

**Prompt caching:**
The system prompt is sent with `cache_control: { type: 'ephemeral' }` to enable Anthropic prompt caching, reducing latency and cost on repeated calls.

**Thread history reconstruction:**
When Grant replies in a thread, the handler fetches the full thread via `conversations.replies` and reconstructs the conversation as alternating user/assistant messages. This gives Claude context like "earlier I drafted X, now Grant is saying send it."

### System Prompt Summary

Claude is instructed to:
- Write as Grant Carlson in first person
- Never send without explicit approval
- Show To: and CC: when presenting drafts
- Save triage rules when Grant gives priority feedback
- Format Slack responses with bold, bullets, and code blocks for drafts

**Writing style baked into system prompt:**
- Professional, calm, direct, collaborative
- "Hi {Name}, hope you're doing well." opener
- "Thanks," / "Thanks!" / "-Grant" closing
- Short paragraphs, one ask at a time
- No corporate filler, no over-apologizing
- Full signature block only on new external emails:
  `Grant Carlson | Milestone Properties | (C) 206-553-9098 (O) 206-775-7335`

---

## File 2: `pages/api/digest.js`

Runs every morning at 7 AM PT via Vercel Cron. Generates and posts the morning email digest.

### Flow

1. Verifies `Authorization: Bearer {CRON_SECRET}` header
2. Returns 200 immediately, runs digest in background via `waitUntil`
3. Fetches last 24 hours of inbox emails (up to 50) via Graph API
4. Loads custom `TRIAGE_RULES` from environment
5. **Spam pre-pass:** sends email list to Claude for spam classification, archives identified spam via Graph API, removes from working set
6. **Triage pass:** sends filtered email list to Claude with full formatting instructions
7. Posts digest to #inbox-digest, appending spam archived count if any
8. Posts a quick-action prompt as a thread reply

### Spam Filtering

The spam pre-pass uses a separate lightweight Claude call that returns only a JSON array of indices (`[0, 3, 7]`). It is intentionally conservative — only marks emails as spam when they are clearly cold solicitations, mass marketing, or phishing. It never marks:
- Known contacts
- Invoices (even unknown vendors)
- Anything property/tenant/deal related
- Government or legal notices

Identified spam is archived via `POST /users/{email}/messages/{id}/move` with `destinationId: 'archive'`. As of this revision, archive failures are logged and counted (not silently discarded) — a failed-archive count appears in both the Slack digest footer and the `digest_runs` row's metadata.

### Digest Format

```
🌅 Morning Digest — [Day, Month Date]

🔧 System Alerts
• [Source] — [Issue]: summary

🔴 Action Required
• [#N] [Sender] — [Subject] [Property tag]: summary

  *Grouped deal:*
  ↳ [#1] Sender — action needed
  ↳ [#2] Sender — action needed

🟡 FYI / Needs Awareness
• [Sender] — [Subject]: summary

[N] emails total — [X] need action
🗑️ N spam emails auto-archived
```

**There is no rendered "⚪ Low Priority / Noise" section.** The live triage prompt in `digest.js` explicitly instructs the model to silently discard anything that would fall in that bucket (automated confirmations, newsletters, routine system reports, Adobe Acrobat comment notifications, successful daily reports) rather than list it. If you want that content visible again — even as a collapsed/de-emphasized section — that's a prompt change in `digest.js`, not currently how it behaves.

**Followed by thread reply:**
`Reply here to act on any email — e.g. "draft reply to #1", "what does #3 say"`

### Digest Intelligence Rules

| Signal | Behavior |
|---|---|
| Sender = "Milestone Properties" (generic) | Resolve to actual source: AppFolio, Internal, etc. |
| 2+ emails about same deal/property | Group under shared header with ↳ arrows |
| Property address in subject/body | Append [Renton], [Burien], [SeaTac] tag |
| Invoice past due date | Prepend ⚠️ OVERDUE |
| Deadline within 48h | Prepend 🕐 DUE SOON |
| Automation error (Zapier, etc.) | Route to 🔧 System Alerts |
| Successful daily reports | Silently discarded (not shown anywhere in the digest) |
| Adobe Acrobat comment notifications | Silently discarded unless a reply is explicitly required |
| Custom TRIAGE_RULES in env | Applied before any other categorization |
| SPF/DMARC auth failure + payment/banking/wire language | Prepends a `🚨 AUTHENTICATION FAILURE DETECTED` banner ahead of the whole digest — a deterministic code check, not the triage model's judgment (see "Authentication forensics" below) |

### Authentication Forensics

Every inbox pull now requests `internetMessageHeaders` and reads the `Authentication-Results` header Microsoft 365 already stamps on inbound mail (`lib/email-parse.js`'s `parseAuthResults`/`isAuthFailure` — no cryptographic verification is performed here, it just reads Microsoft's own verdict). Two things happen with it:

1. The spam pre-pass prompt is told that `spf=fail`/`dmarc=fail` combined with a payment/banking-change request is a spoofing signal even when the display name looks like a known vendor.
2. Independently of what the spam/triage model decides, `digest.js` checks every email that survives the spam filter against `isAuthFailure()` and a payment/wire-fraud keyword heuristic (`looksLikePaymentRequest`). Any match gets a `🚨 AUTHENTICATION FAILURE DETECTED` banner prepended to the digest — this is a hardcoded check, deliberately not routed through the LLM, because the cost of a missed positive (funds sent on a spoofed instruction) is asymmetric to the cost of a false positive.

`digest_runs.metadata.auth_flagged_count` records how often this fires.

---

## Triage Rules System

Grant can update email triage rules by messaging the bot in Slack:
> "Emails from Crystal Li should always be Action Required"
> "AppFolio automated notifications should always be Low Priority"
> "What are my current triage rules?"

The bot uses the `update_triage_rules` tool which:
1. Reads current `TRIAGE_RULES` from `process.env`
2. Adds or removes the rule from the JSON array
3. Calls the Vercel API (`PATCH /v9/projects/{id}/env/{envId}`) to update the env var
4. Rules take effect on the next morning digest

Rules are stored as plain-English strings in a JSON array in the `TRIAGE_RULES` environment variable.

**Requires:** `VERCEL_TOKEN` env var (create at vercel.com/account/tokens)

---

## Deployment

The project is deployed to Vercel. Project and team IDs live in `.vercel/project.json` (linked via `vercel link`) — not repeated here, since this file may be more widely shared than the Vercel project settings should be.

**To deploy:**
```bash
npx vercel --prod
```
Run from the repo root, wherever it's checked out locally.

**To trigger digest manually:**
```bash
curl -X POST https://your-vercel-url.vercel.app/api/digest \
  -H "Authorization: Bearer $CRON_SECRET"
```

---

## Company Context

**Grant Carlson** — Head of Operations  
**Email:** grant@milestoneproperties.net  
**Company:** Milestone Properties — property management, Seattle/Burien/SeaTac area  
**Tools:** AppFolio (property management), Grasshopper (texting)

**Internal team:**
- Rhoda — principal
- Conor Murphy — accounting (accounting@milestoneproperties.net)
- Jamie Masterson — leasing
- Kelsey Dempsey — property manager
- Sabrina, Jeremy, Jeri — staff

**Key external contacts:**
- Josh — Alpine CPAs
- Crystal Li, Jawad Habibi — BECU (lender)
- Shannon Jensvold — Psomas (consultant)
- Merritt Hess — Windermere (agent)

**Known properties:** Burien, SeaTac, Renton, Tukwila

---

## Grant's Email Writing Style

The interactive assistant writes all emails in Grant's voice. Key principles:

- **Opening:** "Hi {Name}, hope you're doing well." — brief and human
- **Body:** 1–2 sentences context, one clear ask, optional delegation
- **Closing:** "Thanks," / "Thanks!" / "-Grant" — no long blocks on replies
- **Signature** (new external emails only): `Grant Carlson | Milestone Properties | (C) 206-553-9098 (O) 206-775-7335`

**Use:** "Could we" / "Do you mind" / "When you have a chance" / "Let me know" / "I'll let {Name} take it away"  
**Avoid:** "Per my last email" / "Kindly advise" / "At your earliest convenience" / "Please don't hesitate" / over-apologizing

Authority is implicit — frame decisions as shared, ask for confirmation, delegate rather than direct. Informality is OK with known collaborators, never with lenders or legal counsel.

---

## Todoist Integration

A separate routine agent (not part of this codebase) reads emails after the morning digest and creates Todoist tasks. Full instructions are in `docs/todoist-agent-instructions.md`.

**Key deduplication rules:**
1. Load all open `email`-labeled Todoist tasks before creating anything
2. Load completed `email`-labeled tasks from last 14 days
3. Skip creation if a matching task (by sender, subject keywords, invoice number) already exists open or was recently completed
4. Re:/Fwd: threads don't generate new tasks unless a genuinely new action is requested
5. Always report skipped count in the Slack summary

---

## Known Limitations & Future Improvements

- **Triage rules are the one thing still stored in env vars** (`TRIAGE_RULES`) rather than Supabase — everything else (email, memory, digest history, conversation state for the Comply bot) is in the database. Interactive-assistant conversation history is still reconstructed from the live Slack thread on each message rather than stored separately.
- **50 email cap** per digest, with no pagination — on a busy day the oldest emails in the 24h window are silently dropped rather than the least important ones. As of this revision, when this cap (or the 12-thread-summary or 20-email-entity-extraction caps) is hit, the digest posts a footer noting it — previously this was only logged server-side and invisible in Slack. Fixing the cap itself (adding pagination) is tracked in `docs/PLAN-tier1-2-reliability.md`, item 5.
- **Spam filter is conservative by design** — borderline emails are not archived; when `AUTO_ARCHIVE_SPAM` isn't set to `true`, they're filtered out of the digest entirely and don't appear anywhere (not routed to a visible section).
- **Triage rule updates require `VERCEL_TOKEN`** — without this, the bot can read rules but not save new ones.
- **Thread context limited to 20 messages** — very long Slack threads may lose early context.
- **Send approval is prompt-enforced only**, not a hard gate — see the "Send approval gate" note above and `docs/PLAN-tier1-2-reliability.md` item 6 for the planned fix.

**Potential future additions:**
- Calendar awareness (flag emails referencing meetings today)
- Attachment summarization (summarize PDFs/docs mentioned in emails)
- Sentiment analysis on tenant emails (flag escalating issues)
- Weekly summary digest (Friday recap of the week's email patterns)
- Read-status tracking (mark emails as read after drafting a reply)

For a fuller, verified-against-code list of reliability gaps and a step-by-step plan to close them, see `docs/PLAN-tier1-2-reliability.md` and `docs/PLAN-tier3-structural.md`.
