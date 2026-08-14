# Outlook-Assistant-Inspired Features — Implementation Plan

### Four features adapted from `littlebearapps/outlook-assistant`, scoped to this codebase

**Repo:** `grantaltom-ms/grant-claudecode`
**Scope:** `pages/api/digest.js`, `pages/api/inbox-assistant.js`, `lib/*`, `supabase/migrations/*`
**Companion docs:** `PLAN-tier1-2-reliability.md` (items 5 and 6 overlap with this plan — see notes below), `inbox-memory-architecture.md`

---

## How to read this

Same format as the Tier 1/2 plan: what's wrong or missing, why it matters here specifically (not just "it's a good idea"), concrete steps grounded in actual file/line locations, and how to verify it worked.

**Source context:** `littlebearapps/outlook-assistant` is a generic MCP server exposing 22 Outlook/Graph tools to any MCP client (Claude Desktop, Cursor, etc.). It is not a triage/digest agent like this system, so most of it doesn't transplant directly. Four pieces are genuinely applicable because they target gaps already documented in this repo: an unenforced send gate, no pre-send recipient checks, a spam filter with no cryptographic signal, and a hard-capped/non-paginated inbox pull.

**Relationship to the existing Tier 1/2 plan — read this first:**
- Item 1 below (allowlist + rate limit) is **complementary to, not a replacement for**, `PLAN-tier1-2-reliability.md` item 6 (the Slack-button hard approval gate). Item 6 is still the higher-value fix — it removes `send_draft` from the model's tools entirely. Item 1 here is a cheap secondary control that belongs *underneath* whatever calls Graph's send endpoint, whether that's today's `send_draft` handler or item 6's future button handler.
- Item 4 below (delta sync) **overlaps with** `PLAN-tier1-2-reliability.md` item 5 (pagination). They solve the same underlying problem (the `$top=50` cap silently dropping mail) two different ways. Recommendation: do item 5 first — it's already scoped, lower-risk, and smaller. Treat delta sync as a later architectural replacement, not an add-on to build alongside pagination.

**Suggested order:** 3 (auth forensics) → 1 (allowlist/rate limit) → 2 (mail tips) → 4 (delta sync, after Tier 2 item 5 lands). Item 3 is independent and highest safety value for a property-management inbox (invoice/wire fraud). Item 4 is the largest and should come last.

---

# 1. Recipient allowlist + send rate limit

**Effort:** 1 day · **Risk:** low (additive checks, doesn't change existing send path structure) · **Files:** new `lib/send-safety.js`, new migration `021_send_log.sql`, `pages/api/inbox-assistant.js`

### What's wrong / opportunity

`send_draft` (tool def `inbox-assistant.js:109`, handler `inbox-assistant.js:1851-1855`) calls Graph's send endpoint with no code-level restriction on who it sends to or how often. `outlook-assistant`'s safety module pairs a recipient allowlist with a session send-rate cap specifically as a backstop against a runaway loop or a bad tool call spraying mail. This system doesn't have that backstop at all today — the entire boundary is the system prompt sentence documented as unenforced in `system-reference.md` ("Send approval gate").

### Design decision worth calling out

A **strict** allowlist (only pre-approved addresses can ever receive mail) doesn't fit this system: Grant emails new tenants, vendors, and one-off contacts as a normal part of the job, so a hard block on unknown recipients would break real usage constantly. Adapt the idea instead of copying it:

- **Rate limit is the real safety net** — a hard cap on sends per rolling 24h that requires explicit override to exceed. This catches the actual failure mode (a bug or bad approval causing many sends) without touching legitimate one-off external email.
- **Allowlist becomes an advisory flag, not a block** — "first time emailing this address" surfaced in Slack alongside the draft, using existing `context_cards`/`entities` data as the known-contacts source plus a `TRUSTED_DOMAINS` env var (default `milestoneproperties.net`). This gives Grant the same signal outlook-assistant's allowlist gives an interactive MCP client, without blocking legitimate business email.

### Steps

1. **Migration `021_send_log.sql`**: `send_log(id bigserial pk, owner_email text, recipient text, message_id text, sent_at timestamptz default now())`. Lock down grants the same way migrations 011/016/017 do for the rest of the memory schema — RLS enabled, no `anon`/`authenticated` grants, server-role only.
2. **`lib/send-safety.js`**:
   - `checkSendRateLimit(supabase, ownerEmail)` — counts `send_log` rows for `ownerEmail` in the last 24h, compares against `MAX_SENDS_PER_DAY` (env var, default e.g. `25`), returns `{ allowed, count, limit }`.
   - `flagNewRecipients(supabase, recipients)` — for each address, checks it against `context_cards`/`entities` (known people) and `TRUSTED_DOMAINS`; returns the subset that are neither a known contact nor on a trusted domain.
3. **Wire the rate check into `send_draft`** (`inbox-assistant.js:1851`): call `checkSendRateLimit` before the Graph send call; if not allowed, skip the send, return a message telling Claude to tell Grant the daily send cap was hit and needs `MAX_SENDS_PER_DAY` raised or an explicit override phrase to proceed. Insert into `send_log` immediately after a successful send.
4. **Wire the advisory flag into `create_draft_reply` and `create_new_draft`** (`inbox-assistant.js:1802`, `1835`): after building the recipient list, call `flagNewRecipients` and append a note to the returned tool result, e.g. `first_time_recipients: ["newvendor@example.com"]`. Update the system prompt (`inbox-assistant.js` ~2036-2041) to have Claude mention this in the Slack message before asking for approval — same "show To:/CC:" pattern already documented, just one more line.
5. **If `PLAN-tier1-2-reliability.md` item 6 lands first**, move the rate-limit check (step 3) into the new button handler's send action instead of `send_draft` — the check belongs at the point where Graph's send endpoint is actually called, wherever that ends up living.

### Verification

- Unit test `send-safety.js` rate limiter against a stubbed Supabase client (matches existing `test/lib` convention) — assert it blocks at the Nth send and allows the (N-1)th.
- Manually pre-populate `send_log` past the limit in a test/staging run and confirm `send_draft` refuses and reports the cap clearly.
- Draft a reply to a known internal contact — confirm no "first time" flag. Draft to a fresh address — confirm the flag appears in the Slack draft message and does **not** block sending.

---

# 2. Pre-send mail tips (out-of-office, full mailbox, delivery restrictions)

**Effort:** 4-6 hours · **Risk:** low (advisory only, wrapped in try/catch) · **Files:** `lib/graph.js`, `pages/api/inbox-assistant.js`

### What's wrong / opportunity

Nothing today checks recipient mailbox state before a draft goes out. Graph's `getMailTips` endpoint returns exactly this — automatic-reply (out-of-office) text, mailbox-full status, and delivery restrictions — and outlook-assistant uses it as a pre-send check. For this system, the useful case is catching "I'm drafting a reply to someone who's currently OOO and the tone/urgency of my draft doesn't match that" before Grant approves and sends.

### Steps

1. **`lib/graph.js`**: add `getMailTips(token, ownerEmail, recipients)` calling `POST /users/{ownerEmail}/getMailTips` with body `{ EmailAddresses: recipients, MailTipsOptions: 'automaticReplies,mailboxFullStatus,deliveryRestriction' }`. Follows the same `graph()` helper pattern already in the file.
2. **In `create_draft_reply` and `create_new_draft`** (`inbox-assistant.js:1802`, `1835`), after resolving the recipient list, call `getMailTips` wrapped in try/catch — mail tips can be slow or unsupported for some recipients (e.g., external domains without cross-org mail tips enabled), and a failure here must never block draft creation. Append any non-empty tips (auto-reply text, full mailbox, restricted) to the tool result.
3. **Update the system prompt** (~2036-2041) so Claude surfaces a mail-tip warning in the Slack draft message, e.g. `⚠️ jsmith@lender.com has an out-of-office reply active: "Out until Aug 5."`
4. **Verify the Azure app registration scope.** `getMailTips` for other users' mailboxes typically needs `MailboxSettings.Read` in addition to the existing `Mail.Read`/`Mail.ReadWrite`/`Mail.Send` application permissions listed in `system-reference.md`. Confirm the current app registration has it before relying on this — if not, add it and get admin consent (same process documented for the existing three permissions).

### Verification

- Draft a reply to a test mailbox with an out-of-office reply configured; confirm the tip surfaces in the Slack message.
- Draft to a normal recipient; confirm no tip clutter appears.
- Temporarily break the mail tips call (bad scope, wrong URL) and confirm draft creation still succeeds — this must degrade silently, not become a new failure mode for drafting.

---

# 3. DKIM/SPF/DMARC signal in the spam/phishing pre-pass

**Effort:** 1 day · **Risk:** low-medium (touches the digest's spam classification, which already auto-archives when `AUTO_ARCHIVE_SPAM=true`) · **Files:** `pages/api/digest.js`, `lib/email-parse.js`

### What's wrong / opportunity

The spam pre-pass (`digest.js:679-725`) is pure LLM judgment over subject/sender/body text pulled from `$select` at `digest.js:632` — there's no cryptographic signal at all. For a property management company, invoice/wire-fraud (a spoofed "AppFolio" or vendor display name asking to update banking details) is a realistic and costly attack, and it's exactly the kind of thing an LLM can be socially engineered on ("this looks like a normal accounting email") while an authentication check would catch instantly. Microsoft 365 already computes SPF/DKIM/DMARC verdicts on inbound mail and stamps them into the `Authentication-Results` header — this doesn't require implementing any cryptographic verification ourselves, just reading a header Graph can return.

### Steps

1. **`digest.js:632`** — add `internetMessageHeaders` to the `$select` list on the inbox pull.
2. **`lib/email-parse.js`** — add `parseAuthResults(headers)`: find the `Authentication-Results` header (case-insensitive name match) and extract `spf=`, `dkim=`, `dmarc=` verdicts via regex. Return `{ spf, dkim, dmarc }` with `null`s if the header is absent (some transport paths omit it — must not throw).
3. **`digest.js` spam pre-pass (~679-704)** — append each email's auth verdict to the `spamCheckList` text fed to Claude, and extend the system prompt for that call with an explicit instruction: treat `dmarc=fail` or `spf=fail` combined with payment/banking/wire-instruction language as high-confidence phishing regardless of how familiar the display name looks.
4. **Add a hardcoded override, not just a prompt hint.** For the specific high-stakes combination — `dmarc=fail` (or `spf=fail`) AND the email body matches payment/wire/banking-change keywords — force a `⚠️ AUTHENTICATION FAILED` prefix in the digest via a code check, not model judgment. This is the one place in the system where a deterministic rule is safer than trusting the LLM, because the cost of a missed positive (funds sent to a fraudulent account) is asymmetric to the cost of a false positive (one extra warning banner).
5. Decide whether to persist the auth verdict on `email_messages` (new column) for the memory/audit trail — optional, only worth it if the entity/context-card layer should be able to answer "was this ever flagged for auth failure."

### Verification

- Build a test fixture (matches `test/fixtures` convention) with a header block containing `dmarc=fail` and payment-related body text; confirm the digest flags it regardless of what the spam-classification model returns.
- Confirm a normal internal email (which passes SPF/DKIM/DMARC) shows no auth warning.
- Confirm an email with no `Authentication-Results` header at all doesn't crash `parseAuthResults` or the digest run.
- Confirm `AUTO_ARCHIVE_SPAM` behavior is unchanged for emails that fail the LLM spam check but pass authentication — this feature adds a new "always flag" path, it should not change what gets auto-archived.

---

# 4. Delta sync for the digest's inbox pull

**Effort:** 2-3 days · **Risk:** medium-high (changes the core data-fetch path for every digest run; requires persisted per-mailbox state and correct handling of token expiration) · **Files:** new migration `022_inbox_delta_state.sql`, `lib/graph.js`, `pages/api/digest.js`

### What's wrong / opportunity, and why this is a *different* fix than Tier 2 item 5

`PLAN-tier1-2-reliability.md` item 5 already scopes fixing the `$top=50`/no-pagination bug at `digest.js:630-632` by following `@odata.nextLink` for a full 24h window each run. That's the right first fix — smaller, lower-risk, already designed.

Delta sync is a structurally different approach: instead of re-fetching a rolling 24h window every run (which paginated fetching still does, just across more pages on a heavy day), Graph's `/messages/delta` endpoint lets the mailbox be asked "what changed since last time" using a persisted `deltaLink`. Steady-state, each run pulls only genuinely new/changed items — a busy day becomes many small deltas instead of one large page-following loop — and the digest cap problem for *new mail volume* disappears rather than just being raised. It's the more correct long-term architecture, but it introduces real complexity Tier 2 item 5 doesn't have: persisted per-mailbox state, an initial full-sync bootstrap, and handling Graph's delta-token expiration (a `410 Gone` after a period of inactivity, requiring a fresh full sync).

**Recommendation:** do Tier 2 item 5 first. Treat this as a future replacement once pagination is live and stable, not a parallel effort — building both at once means maintaining two inbox-fetch code paths during the transition for no real benefit.

### Steps

1. **Migration `022_inbox_delta_state.sql`**: `inbox_delta_state(owner_email text primary key, delta_link text, updated_at timestamptz default now())`, same RLS/lockdown pattern as the rest of the schema.
2. **`lib/graph.js`**: add a delta-aware fetch helper. Initial call: `GET /users/{owner}/mailFolders/Inbox/messages/delta?$select=...`; follow `@odata.nextLink` within a single run using the existing `graphAbsolute()` helper (`lib/graph.js:71-73`) — it already exists specifically because `@odata.nextLink`/`@odata.deltaLink` come back as fully-qualified URLs that can't be re-prefixed through `graph()`. On the final page, capture `@odata.deltaLink` and persist it to `inbox_delta_state`.
3. **`digest.js`**: replace the fixed `$filter=receivedDateTime ge {since}` query (`digest.js:630-632`) with: if `inbox_delta_state` has a stored `delta_link`, call it via `graphAbsolute`; otherwise do one full 24h bootstrap pull (the item-5 pagination logic) and initialize delta tracking from the resulting `@odata.deltaLink`.
4. **Handle `@removed` entries** in the delta response — these represent deletions/moves out of Inbox and must be excluded from the digest's working set, not treated as new mail.
5. **Handle `410 Gone`** (expired/invalidated delta token — Graph resets these after enough inactivity): catch it, fall back to a full 24h bootstrap pull, re-initialize `inbox_delta_state`, and — matching the pattern already established in `PLAN-tier1-2-reliability.md` item 2 — write this resync event into the `digest_runs` stats object rather than only `console.log`ging it, so a mailbox that's silently resyncing every run (which would mean delta sync isn't actually helping) is visible.
6. **Filter to the 24h window in code, not in the Graph query.** Delta feeds surface *changes*, not a clean time window — an item whose read/flag status changed 3 days ago can appear in a delta response. Keep the existing "last 24h" business rule as a post-fetch filter so digest scope doesn't silently change.

### Verification

- Bootstrap run: confirm a `delta_link` gets stored.
- Second run with no new mail: confirm the delta call returns fast with an empty/near-empty diff (verifies steady-state cost dropped vs. the full-window pull).
- Send a test email, run again, confirm it's picked up.
- Manually corrupt the stored `delta_link` and confirm the run falls back to a full bootstrap pull without crashing, and that the resync is visible in `digest_runs`.
- Compare digest output against the paginated-pull version (item 5) on the same real day — counts and content should match; this is a plumbing change, not a triage behavior change.

---

## Rollup

| # | Item | Effort | Risk | Depends on / overlaps |
|---|---|---|---|---|
| 1 | Allowlist flag + send rate limit | 1d | low | Complements Tier 1/2 item 6 |
| 2 | Pre-send mail tips | 4-6h | low | Azure scope check (`MailboxSettings.Read`) |
| 3 | Auth (SPF/DKIM/DMARC) signal in spam pass | 1d | low-med | — |
| 4 | Delta sync for inbox pull | 2-3d | med-high | Do Tier 1/2 item 5 first; overlaps, don't parallelize |

**Total: roughly 1-1.5 weeks**, with item 4 alone accounting for close to half of it and best deferred until pagination (Tier 2 item 5) has shipped and proven out.

None of these should be considered done without lint, build, and tests passing, per the same standing practice as `PLAN-tier1-2-reliability.md`.
