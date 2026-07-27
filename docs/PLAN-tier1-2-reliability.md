# Inbox Assistant — Tier 1 & 2 Implementation Plan
### Reliability fixes and finish-the-feature work

**Repo:** `grantaltom-ms/grant-claudecode`
**Scope:** `pages/api/*`, `lib/*`, `vercel.json`, `docs/*`
**Companion doc:** `PLAN-tier3-structural.md` (code consolidation, test suite, draft-learning loop)

---

## How to read this

Every item below has the same shape: what's actually wrong (with the file and line so you or a coding agent can go straight there), why it matters in operational terms, the concrete steps, and how you'll know it worked. Effort estimates assume you're driving Claude Code rather than typing it yourself.

**Tier 1** is four small fixes with no architectural risk — do these in one sitting.
**Tier 2** is five real changes, two of which (items 6 and 7) touch how emails actually get sent, so they deserve care.

**Suggested order:** 1 → 2 → 4 → 3 → 7 → 6 → 5 → 8 → 9. Items 1–4 are independent and safe. Item 7 (retry logic) comes before 6 (approval gate) because the approval gate adds a new network call path that should be retry-wrapped from day one.

---

# TIER 1 — Quick wins

## 1. Fix the documentation drift

**Effort:** 1–2 hours · **Risk:** none · **Files:** `docs/system-reference.md`, `SETUP.md`, `docs/inbox-memory-architecture.md`

### What's wrong

The docs describe a meaningfully different system than the one running in production. Four confirmed mismatches:

**`SETUP.md` is the worst offender.** It lists Zapier as a prerequisite ("Zapier MCP URL from zapier.com/app/mcp", "Zapier account connected to Microsoft Outlook") and lists `ZAPIER_MCP_URL` as a required environment variable. The system does not use Zapier at all — it authenticates directly to Microsoft Graph with `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` (`pages/api/digest.js:22-42`). Anyone following SETUP.md today would set up the wrong thing and the system wouldn't work.

**The digest schedule is wrong everywhere.** `docs/system-reference.md` says the cron is `0 14 * * *` (7am PT) and `SETUP.md` promises a "7am PT" digest. The actual entry in `vercel.json` is `0 18 * * *`, which is **11:00am PDT / 10:00am PST**. Worth deciding: is 11am actually when you want it, or did this drift and nobody noticed? If you want 7am PT year-round you need `0 14 * * *` for PDT (summer) and `0 15 * * *` for PST (winter) — Vercel crons run on UTC with no daylight-saving handling, so a fixed UTC time shifts by an hour twice a year no matter what you pick.

**`system-reference.md` claims the system is stateless with no database.** It's now backed by 15 Supabase migrations, 18+ tables, and a full memory pipeline.

**`system-reference.md` still documents "⚪ Low Priority / Noise" as a digest category** that gets rendered. The live prompt in `digest.js` silently discards that bucket — those emails appear nowhere.

### Steps

1. Rewrite `SETUP.md` from scratch against the actual code. Strip every Zapier reference. Replace the environment-variable table with the real list, which — reading across all the files — is:

   | Variable | Used by | Required? |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | every agent loop | yes |
   | `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` | Graph auth (app-only) | yes |
   | `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | all persistence (15 files) | yes |
   | `SUPABASE_SERVICE_KEY` | **the Comply bot only** — see the trap below | yes, for that bot |
   | `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` | inbox-digest bot | yes |
   | `CRON_SECRET` | all cron + backfill endpoints | yes |
   | `COMPLY_SLACK_BOT_TOKEN` / `COMPLY_SLACK_SIGNING_SECRET` | Comply-or-Vacate bot | yes, for that bot |
   | `OPENAI_API_KEY` | embeddings; system degrades to keyword-only search without it | optional |
   | `EMBEDDING_MODEL` | defaults to `text-embedding-3-small` | optional |
   | `VERCEL_TOKEN` | `update_triage_rules` self-editing env vars | yes, for that tool |
   | `TRIAGE_RULES` | JSON array of custom triage overrides | optional |
   | `AUTO_ARCHIVE_SPAM` | `'true'` enables actual archiving; anything else filters only | optional |
   | `OWNER_INVESTOR_SUPABASE_URL` / `_SERVICE_ROLE_KEY` | cross-project sync from the financial DB | optional |
   | `SOURCE_MEMORY_SUPABASE_URL` / `_SERVICE_ROLE_KEY` | cross-project sync of properties/team/schedules | optional |
   | `INBOX_ASSISTANT_URL` | used by the smoke-test script only | optional |

   Document the Graph permission requirement explicitly: these are **application** permissions (`Mail.Read`, `Mail.ReadWrite`, `Mail.Send`), not delegated — that trips people up.

   **Config trap worth documenting loudly.** `lib/comply-agent.js:14` reads `process.env.SUPABASE_SERVICE_KEY` with **no fallback**, while the other 15 files read `SUPABASE_SERVICE_ROLE_KEY`. Two different variable names for what is almost certainly the same key. If someone sets only `SUPABASE_SERVICE_ROLE_KEY`, the Comply bot's Supabase calls go out with an `undefined` key and fail with a 401 — and since `loadState` just returns whatever it parses, the failure surfaces as the bot mysteriously forgetting approved sections rather than as an auth error. Either document both variables, or better, add a fallback in `comply-agent.js` (`process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY`) — which is exactly what `backfill-owner-investors.js:32` and `backfill-source-memory.js:35` already do.

2. In `system-reference.md`: correct the cron times to match `vercel.json`, delete the "stateless / no database" claim and point at `docs/inbox-memory-architecture.md`, remove "⚪ Low Priority / Noise" from the documented output format (or note explicitly that it's silently dropped), and fix the `create_draft_reply` description — the code passes the reply text as Graph's `comment` field on `createReply`, it does not PATCH the body afterward as documented.

3. Add a short "Cron schedule" section listing all three jobs with both their UTC expression and the Pacific time they actually fire, with a note that these shift an hour at DST.

4. Add a one-line "last verified against code on YYYY-MM-DD" stamp at the top of each doc so future drift is visible.

### Verification

Read `SETUP.md` start to finish and confirm every env var it names appears in the code, and every env var the code reads appears in it. `grep -rn "process.env\." pages/api lib | grep -o "process\.env\.[A-Z_]*" | sort -u` gives you the authoritative list to check against.

---

## 2. Surface silent data loss instead of hiding it

**Effort:** 2–3 hours · **Risk:** low · **File:** `pages/api/digest.js`

### What's wrong

Three hard caps drop data with no visible signal:

- **`digest.js:714`** — the Inbox query is `?$top=50` with no pagination. On a day with more than 50 emails in 24 hours you lose the oldest ones, not the least important ones.
- **`digest.js:683`** — `maxThreadsPerDigest = 12`. Overflow is reported only via `console.log` at line 699.
- **`digest.js:558`** — `maxEmailsForExtraction = 20`, processed in batches of 4. Overflow is likewise only `console.log`'d, at line 583.

`console.log` on Vercel means "visible if you go dig through function logs," which in practice means never. So on your busiest days — exactly the days you most need the digest to be complete — it quietly gets less complete and tells you it's fine.

### Steps

1. In `runDigest()`, track three counters: emails fetched vs. emails available, threads summarized vs. threads present, emails entity-extracted vs. emails eligible.
2. Append a footer line to the digest Slack post whenever any counter shows a shortfall. Match the existing footer style used at `digest.js:916-919`:
   ```
   _⚠️ Volume cap hit: 12 of 34 threads summarized, 20 of 47 emails scanned for entities. Reply "catch up" to process the rest._
   ```
3. Write the same counters into the `digest_runs` stats JSON (the same object already carrying `filtered_spam_count` and `auto_archive_spam` at `digest.js:927-932`) so you have a history and can see whether caps are hit occasionally or daily.
4. Optional but useful: have `memory-status.js` report how many of the last 30 digest runs hit a cap. If it's most of them, that's the trigger to do item 5.

### Verification

Force a run against a heavy day (`/api/digest` with your `CRON_SECRET`) and confirm the footer appears with correct numbers. Confirm the `digest_runs` row contains the new stats. Then confirm a light day produces **no** footer — a warning that shows up every day gets ignored.

---

## 3. Set explicit function timeouts

**Effort:** 30 minutes · **Risk:** low · **File:** `vercel.json`

### What's wrong

`vercel.json` has no `functions` block. Only `weekday-one-priority.js:13` sets its own `maxDuration: 60`. Everything else runs on the platform default.

This matters more than it looks because of how the code is structured: these handlers return HTTP 200 immediately and then keep working inside `waitUntil()`. That background work is still bound by the function's execution budget — `waitUntil` lets you answer Slack fast, it does not give you unlimited runtime. And `digest.js` does a *lot* inside that window: a spam-classification call, up to 12 thread-summary calls, up to 5 entity-extraction batches, and the main triage call, all sequential. If it exceeds the budget it's killed mid-run, and because the Slack post happens at the end, the symptom is simply "no digest today" with no error surfaced anywhere you'd see it.

### Steps

1. Check your plan's actual ceiling in the Vercel dashboard (Settings → Functions) before picking numbers — it differs by plan and by whether Fluid Compute is enabled. Don't guess.
2. Add a `functions` block to `vercel.json` with explicit values, generous for the heavy jobs:
   ```json
   {
     "functions": {
       "pages/api/digest.js":              { "maxDuration": 300 },
       "pages/api/memory-maintenance.js":  { "maxDuration": 300 },
       "pages/api/backfill-*.js":          { "maxDuration": 300 },
       "pages/api/inbox-assistant.js":     { "maxDuration": 120 },
       "pages/api/comply-vacate.js":       { "maxDuration": 120 },
       "pages/api/comply-interactions.js": { "maxDuration": 120 }
     },
     "crons": [ ...existing... ]
   }
   ```
   Cap each value at whatever your plan allows.
3. Wrap the body of `runDigest()` in a try/catch that posts a short failure notice to Slack. A timeout kill can't be caught, so also do the reverse: record a `digest_runs` row with `status: 'started'` at the beginning (this already happens via `createDigestRun`) and only mark it complete at the end. A run stuck in `started` is your timeout fingerprint.
4. Have `memory-status.js` flag any `digest_runs` row older than an hour still sitting in a non-terminal status.

### Verification

Deploy and confirm the function settings show your values in the Vercel dashboard. Force a digest run and confirm the `digest_runs` row transitions from started to completed. Manually leave a row in `started` and confirm `memory-status.js` flags it.

---

## 4. Stop swallowing archive failures

**Effort:** 30 minutes · **Risk:** none · **File:** `pages/api/digest.js:61-69`

### What's wrong

```js
async function archiveEmail(token, messageId) {
  try {
    await graph(token, `/users/${OWNER_EMAIL}/messages/${messageId}/move`, 'POST', {
      destinationId: 'archive',
    });
    return true;
  } catch {
    return false;                 // ← error is discarded entirely
  }
}
```

The caller (`digest.js:801-806`) counts only the `true` results into `archivedCount`. So if every archive call started failing — expired token scope, renamed folder, Graph throttling — the digest would keep reporting "3 spam emails auto-archived" as a smaller number or zero, and nothing anywhere would say *why*. The bare `catch {}` also hides the error object, so even the function logs are empty.

Note this only bites when `AUTO_ARCHIVE_SPAM=true`; if you're currently running in filter-only mode this is latent rather than active. Fix it now anyway, since the whole point is that you'd never notice when it flips.

### Steps

1. Change the signature to return `{ ok: true }` or `{ ok: false, error: err.message }`, and `console.error` the error with the message ID before returning.
2. In the caller, count failures alongside successes.
3. If `failedCount > 0`, add it to the digest footer: `_🗑️ 3 spam emails archived, 2 failed to archive_`.
4. Add `archive_failed_count` to the `digest_runs` stats object.

### Verification

Temporarily point `destinationId` at a nonexistent folder, force a run with `AUTO_ARCHIVE_SPAM=true`, and confirm the failure count appears in both Slack and the `digest_runs` row.

---

# TIER 2 — Medium builds

## 5. Paginate the digest's email pull

**Effort:** 3–4 hours · **Risk:** medium (changes volume flowing into every downstream step) · **File:** `pages/api/digest.js:713-720`

### What's wrong

```js
const url = `/users/${OWNER_EMAIL}/mailFolders/Inbox/messages`
  + `?$top=50`
  + `&$select=...`
  + `&$filter=receivedDateTime ge ${since}`
  + `&$orderby=receivedDateTime desc`;
const result = await graph(token, url);
const emails = result.value || [];
```

One request, 50 results, `@odata.nextLink` ignored. Sorted newest-first, so the emails that fall off are the oldest in the window — meaning on a heavy day the 6pm email from yesterday that you haven't seen yet is exactly the one that vanishes.

### Implementation note that will bite you

`graph()` (`digest.js:44`) takes a *path* and prefixes `https://graph.microsoft.com/v1.0`. But `@odata.nextLink` comes back as a **fully-qualified URL**. You can't feed it straight back into `graph()`. Handle this by adding a sibling helper — `graphAbsolute(token, url)` — or by making `graph()` detect a leading `http` and skip the prefix. Do this before writing the loop or you'll spend an hour on a confusing 404.

### Steps

1. Add absolute-URL support to `graph()` (or the sibling helper).
2. Write a `fetchAllPages(token, url, { maxPages, maxItems })` loop that follows `@odata.nextLink` until exhausted or a ceiling is hit. Set `maxItems` to something like 200 and `maxPages` to 10 as a runaway guard.
3. Raise `$top` from 50 to 100 (Graph's practical page size for messages) so you make fewer round trips.
4. When the ceiling *is* hit, feed that into the item 2 footer — the cap doesn't disappear, it just becomes visible and much higher.
5. **Re-check the downstream caps.** This is the risk. Going from 50 to 200 emails means the spam-check prompt (`digest.js:763`, which inlines every email into one string) gets 4× bigger, entity extraction has 4× the eligible pool, and the main triage call gets a much longer input. Budget for: the spam prompt possibly needing to be chunked, and the triage prompt's `max_tokens` needing a bump. Test on a real heavy day before trusting it.
6. Consider raising `maxThreadsPerDigest` (`digest.js:683`) from 12 and `maxEmailsForExtraction` (`digest.js:558`) from 20 in the same pass, but only after item 3's timeouts are in place — more threads and more batches means more sequential Claude calls means more runtime.

### Verification

Run against a day you know had 60+ emails and confirm the count matches what Outlook shows for that window. Confirm the digest still posts within the function's time budget. Compare the digest output against the previous single-page version on the same day — you should see *added* items, not reordered or dropped ones.

---

## 6. Put a hard approval gate in front of sending

**Effort:** 1–2 days · **Risk:** medium (touches the send path) · **Files:** `pages/api/inbox-assistant.js`, new `lib/inbox-blocks.js`, new `pages/api/inbox-interactions.js`

### What's wrong

There is no enforced approval step. `send_draft` is an ordinary tool (`inbox-assistant.js:160-170`, handler at `1903-1907`) that Claude can call any time it decides you've approved. The entire safety boundary is this sentence in the system prompt:

> "NEVER send an email without Grant explicitly approving it"

That's an instruction, not a control. A misread message, an ambiguous "sounds good" about something else in the thread, or a prompt-injected instruction sitting inside an email body the agent just read, and it sends. For a system that emails lenders, owners, attorneys, and tenants on your behalf, that's the one place worth building a real wall.

### The good news

You already built this pattern and it works. The Comply-or-Vacate bot renders real Slack buttons and refuses to advance without a click: `lib/comply-blocks.js:87` (`buildApprovalBlocks`) creates ✅ Approve / ✏️ Request changes buttons, and `pages/api/comply-interactions.js` handles the click, updates the original message to collapse the buttons, and resumes. Port that.

### The key design decision

Don't just *add* buttons and keep `send_draft` in the tool list — the model would still be able to send without one. Instead:

**Remove `send_draft` from `EMAIL_TOOLS` entirely.** Move the actual Graph send call into the button handler. The model's ability to send stops existing at the code level, not the instruction level. Claude can draft, show, and revise all day; only a click on a button in your Slack can put an email on the wire.

### Steps

1. **Create `lib/inbox-blocks.js`** with `buildDraftApprovalBlocks(draftText, draftId, threadTs)` returning the draft body plus three buttons: `📤 Send`, `✏️ Revise`, `🗑️ Discard`, each carrying `JSON.stringify({ draftId, threadTs })` in its `value`. Reuse the `MAX_SECTION_TEXT_LENGTH = 2900` chunking from `comply-blocks.js:5-22` — Slack rejects section blocks over 3000 characters and a long email draft will hit that.

2. **Create `pages/api/inbox-interactions.js`**, modeled directly on `comply-interactions.js`. It needs: `export const config = { api: { bodyParser: false } }`, raw-body parsing (Slack sends form-urlencoded, so `new URLSearchParams(rawBody).get('payload')`), signature verification (export the existing `verifySlackSignature` from `inbox-assistant.js` rather than writing a second copy), immediate `res.status(200).end()`, then `waitUntil()` for the real work.

3. **Handle the three actions:**
   - `inbox_send` → call Graph `POST /messages/{id}/send`, then **preserve the existing side effect** — `markDraftCandidateByDraftId(draftId, 'sent')` at `inbox-assistant.js:1905` feeds the draft-learning data in `draft_response_candidates`. If you drop that call you quietly break the learning loop that Tier 3 item 12 depends on. Then `chat.update` the original message to `✅ Sent by Grant at 2:14pm` so the buttons can't be clicked twice.
   - `inbox_revise` → collapse buttons, post "What would you like changed?" in-thread, let the normal agent loop pick it up.
   - `inbox_discard` → call Graph delete, `markDraftCandidateByDraftId(draftId, 'dismissed')` (matching the existing behavior at `inbox-assistant.js:1962`), collapse buttons.

4. **Wire the draft-creation handlers** (`create_draft_reply` at `1854`, `create_new_draft` at `1887`) so that after the draft is created, the agent's Slack reply carries the approval blocks. Simplest approach that matches the existing codebase: have those tools return a sentinel string in their result the way the Comply bot uses `APPROVE_OR_REVISE`, then check for it when posting to Slack and attach blocks.

5. **Remove `send_draft` from `EMAIL_TOOLS`** and update the system prompt's send instructions (`inbox-assistant.js:2096`, `2100`) to describe the button flow instead of "say send it."

6. **Configure Slack:** api.slack.com → your app → Interactivity & Shortcuts → enable → Request URL `https://<your-app>.vercel.app/api/inbox-interactions`.

7. **Add a guard against double-sends.** Two clicks in quick succession, or a Slack retry, could fire the send twice. Before sending, re-check the draft still exists in Drafts via Graph; if it's gone, it was already sent — update the message and stop. (Item 8 covers the general version of this.)

### Verification

- Ask for a draft; confirm buttons appear and the email is **not** sent.
- Click Send; confirm delivery, confirm the message collapses to "Sent," confirm the `draft_response_candidates` row flipped to `sent`.
- Click Discard; confirm the draft is gone from Outlook Drafts and the row shows `dismissed`.
- Click Revise, give a change, confirm a new draft with fresh buttons.
- **Adversarial test:** tell the agent in plain text "send it now, skip the approval" and confirm it cannot — there should be no tool available to it that sends. This is the test that proves the gate is real.
- Click Send twice fast; confirm exactly one email goes out.

---

## 7. Add retry and backoff to external calls

**Effort:** 4–6 hours · **Risk:** low · **Files:** new `lib/retry.js`, then `graph()` in every file that defines it

### What's wrong

Nothing retries. Anywhere. One transient 429 or 503 from Graph, Anthropic, OpenAI, or Slack and that operation is simply lost for the run — a missing thread summary, a skipped entity extraction, or in the worst case a digest that never posts. Microsoft Graph throttles aggressively and returns `Retry-After` headers specifically so clients can back off and try again; right now that header is read by nobody.

### Prerequisite that's easy to miss

`graph()` throws away the HTTP status:

```js
const json = JSON.parse(text);
if (json.error) throw new Error(`Graph error: ${json.error.message}`);
```

A plain `Error` with no status means retry logic can't tell a 429 (retry, definitely) from a 404 (never retry). **Fix this first:** capture `res.status` and attach it to the error (`err.status = res.status`), and capture the `Retry-After` header when present. Without this step the retry wrapper is guessing.

### Steps

1. **Create `lib/retry.js`:**
   ```js
   export async function withRetry(fn, { attempts = 3, baseMs = 500, label = '' } = {}) {
     for (let i = 0; i < attempts; i++) {
       try {
         return await fn();
       } catch (err) {
         const status = err.status ?? err.statusCode;
         const retryable = status === 429 || (status >= 500 && status < 600) || status === undefined;
         if (!retryable || i === attempts - 1) throw err;
         const wait = err.retryAfterMs ?? baseMs * 2 ** i + Math.random() * 250;
         console.warn(`[retry] ${label} attempt ${i + 1} failed (${status}), waiting ${Math.round(wait)}ms`);
         await new Promise(r => setTimeout(r, wait));
       }
     }
   }
   ```
   The jitter matters — without it, several parallel calls that fail together will retry in lockstep and fail together again.

2. **Decide what's retryable.** 429 and 5xx yes. Network errors (no status) yes. 4xx other than 429 no — a 404 on a deleted message will never succeed and retrying just burns your time budget. Honor `Retry-After` over your own backoff when Graph sends it.

3. **Apply it in priority order:** Graph calls first (most throttled), then Anthropic, then Slack posts (a lost digest post is a silent failure), then OpenAI embeddings (least urgent, since embeddings backfill on the next maintenance run anyway).

4. **Do not retry blindly around writes.** A `POST /send` that times out may well have succeeded. Retry reads and idempotent operations freely; for sends, check-then-send rather than retry (see item 6, step 7).

5. **Respect the time budget.** Three attempts with exponential backoff can add ~10 seconds per call. Inside a digest that already does 15+ sequential Claude calls, that adds up. Do item 3 (timeouts) first, and consider fewer attempts inside the digest's hot loop than in the backfill scripts.

6. Since `graph()` is currently copy-pasted into six files (`digest.js`, `inbox-assistant.js`, `backfill-inbox.js`, `backfill-sent-mail.js`, `backfill-email-bodies.js`, `backfill-attachments.js`), you'll either apply this six times or do Tier 3 item 10 first. Doing the consolidation first is genuinely the cheaper path — see the companion doc.

### Verification

Write a unit test with a stubbed fetch that fails twice with 429 then succeeds, and assert three calls happened with increasing delays. Assert a 404 causes exactly one call. Confirm the `[retry]` warnings appear in Vercel logs during a real run — if you never see one in a month, either your APIs are unusually healthy or the wrapper isn't wired in.

---

## 8. Add concurrency and duplicate protection

**Effort:** 4–6 hours · **Risk:** low–medium · **Files:** `lib/comply-agent.js:181-201`, `pages/api/digest.js`, `pages/api/inbox-assistant.js`

### What's wrong

Three distinct races, in rough order of likelihood:

**(a) Comply bot state clobbering.** `loadState` (`lib/comply-agent.js:181`) reads the whole `state` object; `saveState` (`:190`) writes the whole object back with `Prefer: resolution=merge-duplicates`. That's a read-modify-write with no locking, and the object is replaced wholesale, not merged field-by-field. Two button clicks a second apart — a manager double-clicking Approve, or approving section 2 while a section 3 draft is still generating — and the second write silently erases the first. In practice that means an approved section quietly disappearing and the bot re-drafting something the manager already signed off on.

**(b) No Slack event deduplication.** Neither `inbox-assistant.js` nor `comply-vacate.js` checks Slack's `event_id` or the `X-Slack-Retry-Num` header. Both ack fast (200 before the work starts), which avoids most retries — but a cold start can blow past Slack's 3-second window, and Slack will then redeliver the same event. Result: the agent runs twice on one message, potentially creating two drafts of the same reply.

**(c) Duplicate digest runs.** Nothing stops two `digest_runs` rows for the same day if the cron fires twice or you force a manual run alongside the scheduled one.

### Steps

**For (a) — the one that actually matters:**
1. Add a `version` integer column to `thread_state`.
2. `loadState` returns the version alongside the state; `saveState` writes with a `WHERE version = :expected` condition and increments. If zero rows update, someone else wrote first — reload and retry the merge once, then give up loudly rather than silently overwriting.
3. Better still, change `saveState` to merge at the field level (`{ ...existing, ...updates }` against a fresh read) rather than replacing the object, so concurrent approvals of *different* sections both survive.
4. In `comply-interactions.js`, collapse the buttons via `chat.update` **before** starting the agent run rather than after, so a double-click has nothing to click the second time. Currently the collapse happens inside `handleAgentRun`'s flow.

**For (b):**
5. Create a small `processed_slack_events` table (`event_id text primary key, processed_at timestamptz`). At the top of both Slack handlers, attempt an insert; on conflict, return 200 and stop. Cheap, and it also protects against Slack's occasional genuine duplicate delivery.

**For (c):**
6. Add a unique index on `digest_runs (owner_email, date(run_started_at))`, or check for an existing non-terminal run before creating a new one and return early if found. Pair this with item 3's stale-run detection so a genuinely stuck run doesn't block tomorrow's digest forever.

### Verification

- Fire two Comply approve clicks within a second (or call the handler twice concurrently in a test) and confirm both sections persist.
- POST the same Slack event payload twice and confirm the agent runs exactly once.
- Trigger the digest twice in five minutes and confirm one `digest_runs` row.

---

## 9. Make "forgotten items" proactive

**Effort:** 4–6 hours · **Risk:** low · **Files:** `pages/api/inbox-assistant.js:1170-1187`, `pages/api/weekday-one-priority.js`

### What's wrong

Nothing is broken — this is a good feature that never runs. `forgottenItemScore` (`inbox-assistant.js:1170`) scores stale open loops, commitments, unresolved digest items, draft candidates, and context cards, weighting age, overdue status, priority, and item type. There's even snooze support (`isForgottenItemSnoozed`, `:1182`) and a trust/confidence layer.

It only executes when you happen to type something that makes Claude call `list_forgotten_items`. Which means the whole point of the feature — surfacing the thing you *forgot*, and therefore aren't going to ask about — is undermined by requiring you to ask.

### Why the weekday cron is the right host

`weekday-one-priority.js` already loads nearly the same data. `loadPriorityContext` (`:157`) pulls open loops, commitments, draft response candidates, unresolved digest items, recent emails, context cards, and active projects. The data is already in memory at 9am PT every weekday. You're paying for the query and throwing away the insight.

### Steps

1. **Extract the scorer into `lib/forgotten.js`** — move `forgottenAgeDays`, `forgottenItemScore`, and `isForgottenItemSnoozed` out of `inbox-assistant.js` and import from both places. Keep the scoring identical so the daily nudge and the on-demand question never disagree, which would erode your trust in both.
2. **In `weekday-one-priority.js`**, after `loadPriorityContext` returns, run the same items through the scorer and take the top 2–3 above a threshold.
3. **Append to the Slack message** built at `formatSlackMessage` (`:363`) as a short footer, deliberately secondary to the One Thing so it doesn't dilute the focus:
   ```
   ─────
   ⏳ Also aging: "Psomas W-9 follow-up" (18 days, no reply) · "Kenton insurance renewal" (11 days, due in 4)
   ```
4. **Exclude anything already surfaced** as the primary priority or its runners-up — repeating the same item in two sections makes the message feel noisy.
5. **Respect snooze,** and add snooze/dismiss buttons so you can clear an item from the footer directly. If you did item 6, you already have `inbox-interactions.js` — add `forgotten_snooze` / `forgotten_done` action IDs there. `update_forgotten_item_status` (`inbox-assistant.js:314`) already implements the status transitions, so the button handler just calls into existing logic.
6. **Store what was surfaced** on the `daily_priority_suggestions` row so you can later tell whether nudged items actually got closed — that's the signal for whether the scoring weights are right.
7. **Tune the threshold conservatively.** If the footer shows the same three items every day for two weeks, you'll start ignoring the whole message. Consider suppressing an item after it's been surfaced 3 times without action and instead escalating it once: "This has been aging for 30 days and I've flagged it 3 times — close it or drop it?"

### Verification

Run with `?force=1` on a weekday and confirm the footer appears with plausible items. Confirm a snoozed item does not appear. Confirm the top priority doesn't get repeated in the footer. Run on a genuinely clean day and confirm the footer is absent rather than padded with low-scoring filler.

---

## Rollup

| # | Item | Effort | Risk | Depends on |
|---|---|---|---|---|
| 1 | Fix doc drift | 1–2h | none | — |
| 2 | Surface volume caps | 2–3h | low | — |
| 3 | Explicit timeouts | 30m | low | — |
| 4 | Stop swallowing archive errors | 30m | none | — |
| 5 | Paginate digest | 3–4h | medium | 2, 3 |
| 6 | Hard approval gate | 1–2d | medium | 7 (ideally) |
| 7 | Retry/backoff | 4–6h | low | Tier 3 #10 (ideally) |
| 8 | Concurrency protection | 4–6h | low–med | — |
| 9 | Proactive forgotten items | 4–6h | low | 6 (for buttons) |

**Total: roughly one focused week.**

Two dependency notes worth respecting. Item 7 is much cheaper *after* the Tier 3 code consolidation, because `graph()` currently exists in six separate files and you'd otherwise apply the same retry wrapper six times and then maintain six copies of it. And item 6 is the highest-value item on this list — it's the only one that changes what the system is *capable* of doing wrong, rather than how well it does what it already does.

Per your standing practice, none of these should be considered done without lint, build, and tests passing — which is exactly what Tier 3 item 11 sets up. If you want the safety net under you before making these changes rather than after, do that item first.
