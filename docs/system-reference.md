# Milestone Properties — AI Inbox Assistant
## System Reference Document

> Upload this file to a Claude project to give Claude full context on how this system is built, what it does, and how to extend or debug it.

---

## What This System Does

This is a fully custom AI email assistant for Grant Carlson (grant@milestoneproperties.net) at Milestone Properties. It has two modes:

1. **Morning Digest** — Every day at 7:00 AM PT, it reads the last 24 hours of email, filters spam, triages the rest into priority categories, and posts a structured summary to the Slack channel #inbox-digest.

2. **Interactive Assistant** — Grant can message the bot directly in #inbox-digest at any time. The bot can read, search, summarize, and draft emails, then send them after Grant explicitly approves.

Everything lives in a single Next.js project deployed on Vercel. There is no database — the system is stateless, reading live from Outlook and posting to Slack on each invocation.

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

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API access |
| `SLACK_BOT_TOKEN` | Slack bot posting (xoxb-...) |
| `SLACK_SIGNING_SECRET` | Vercel webhook signature verification |
| `AZURE_TENANT_ID` | `469bd392-c1e4-4678-8aa5-db5cf792851a` |
| `AZURE_CLIENT_ID` | `c5943140-46e4-42af-a096-3e4c57b2b570` |
| `AZURE_CLIENT_SECRET` | Azure app secret Value (regenerate if compromised) |
| `CRON_SECRET` | Shared secret for authenticating cron calls |
| `VERCEL_TOKEN` | Vercel API token — used by bot to save triage rules |
| `TRIAGE_RULES` | JSON array of custom triage rules (managed by bot) |

---

## Azure App Registration

**App:** registered in Azure Active Directory  
**Auth flow:** Client Credentials (no user login required — server-to-server)  
**Required Microsoft Graph Application Permissions:**
- `Mail.Read` — read inbox
- `Mail.ReadWrite` — create drafts, move/archive emails
- `Mail.Send` — send emails

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

## vercel.json

```json
{
  "functions": {
    "pages/api/inbox-assistant.js": { "maxDuration": 60 },
    "pages/api/digest.js": { "maxDuration": 60 }
  },
  "crons": [
    { "path": "/api/digest", "schedule": "0 14 * * *" }
  ]
}
```

`0 14 * * *` = 14:00 UTC = 7:00 AM PT daily. Cron requires Vercel Pro plan.

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
`create_draft_reply` fetches `ccRecipients` from the original email before creating the reply draft, then explicitly PATCHes them back in. This ensures CC recipients are never dropped.

**Thread continuity:**
Reply drafts are created using Graph API's `createReply` endpoint (which sets `conversationId` and reply headers), then PATCHed with an HTML body. Using HTML rather than plain text preserves Outlook's thread display.

**Send approval gate:**
The system prompt explicitly prohibits sending without approval. `send_draft` is only defined as a tool — Claude must make a judgment call to use it, and the system prompt instructs it to only do so when Grant says "send it", "looks good", "go ahead", etc.

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

Identified spam is archived via `POST /users/{email}/messages/{id}/move` with `destinationId: 'archive'`. Archive failures are caught silently to avoid breaking the digest.

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

⚪ Low Priority / Noise
• [Sender] — [Subject]

[N] emails total — [X] need action
🗑️ N spam emails auto-archived
```

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
| Successful daily reports | Route to ⚪ Low Priority |
| Adobe Acrobat comment notifications | ⚪ Low Priority unless reply explicitly required |
| Custom TRIAGE_RULES in env | Applied before any other categorization |

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

The project is deployed to Vercel under the team `grantaltom-ms-projects`.

**Production URL:** `https://inbox-assistant-one.vercel.app`  
**Project ID:** `prj_1eeFtlROsHRqaCD3HkvGC6m9XMJX`  
**Team ID:** `team_1mUqHwC1cSBZNn1LlIFJJube`

**To deploy:**
```bash
cd /Users/grantcarlson/Claude/inbox-assistant
npx vercel --prod
```

**To trigger digest manually:**
```bash
curl -X POST https://inbox-assistant-one.vercel.app/api/digest \
  -H "Authorization: Bearer {CRON_SECRET}"
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

- **No persistent storage** — triage rules are stored in env vars; conversation history is reconstructed from Slack thread on each message
- **50 email cap** per digest — if inbox gets very busy, oldest emails may be missed
- **Spam filter is conservative by design** — borderline emails are not archived; they appear in Low Priority instead
- **Triage rule updates require `VERCEL_TOKEN`** — without this, the bot can read rules but not save new ones
- **Thread context limited to 20 messages** — very long Slack threads may lose early context

**Potential future additions:**
- Calendar awareness (flag emails referencing meetings today)
- Attachment summarization (summarize PDFs/docs mentioned in emails)
- Sentiment analysis on tenant emails (flag escalating issues)
- Weekly summary digest (Friday recap of the week's email patterns)
- Read-status tracking (mark emails as read after drafting a reply)
