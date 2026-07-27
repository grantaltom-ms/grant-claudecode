# Inbox Assistant — Tier 3 Implementation Plan
### Structural work: consolidation, testing, and the draft-learning loop

**Repo:** `grantaltom-ms/grant-claudecode`
**Scope:** `pages/api/*`, `lib/*`, `.github/workflows/*`, `package.json`, Supabase migrations
**Companion doc:** `PLAN-tier1-2-reliability.md` (quick wins and medium reliability fixes)

---

## How to read this

Three items, but they're not the same kind of work. Item 10 is a refactor that touches many files and changes no behavior. Item 11 builds the safety net that makes every future change cheaper. Item 12 is a genuine new capability that happens to be mostly built already.

**Order matters here more than in Tier 1–2:** 10 → 11 → 12, and it's worth being strict about it. Consolidating first means the tests you write in item 11 cover one copy of each function instead of six. Testing before item 12 means you're adding an auto-drafting feature — the highest-consequence thing in this system — on top of a suite that can tell you when you broke something.

If you only have appetite for one, do **item 11**. It's the one that changes how safely you can do everything else.

---

## 10. Consolidate the duplicated Graph and Claude code

**Effort:** 1–2 days · **Risk:** medium (touches many files, but purely mechanical) · **Behavior change:** none

### What's wrong

Core helpers are copy-pasted across the codebase. Verified counts:

| Function | Copies | Files |
|---|---|---|
| `getGraphToken()` | **6** | `digest.js`, `inbox-assistant.js`, `backfill-inbox.js`, `backfill-sent-mail.js`, `backfill-email-bodies.js`, `backfill-attachments.js` |
| `graph()` | **6** | same six |
| `htmlToText()` | **4** | `digest.js`, `backfill-inbox.js`, `backfill-sent-mail.js`, `backfill-email-bodies.js` |
| `extractBodyFields()` | **4** | same four |

Plus the near-identical entity-extraction prompts across `digest.js` and `backfill-entities.js`, and near-identical Slack posting helpers in `digest.js`, `inbox-assistant.js`, and `weekday-one-priority.js`.

Only the Comply-or-Vacate bot uses a shared module (`lib/comply-agent.js`, `lib/comply-blocks.js`) — which is exactly the pattern to extend.

### Why this is worth a day

It's not about elegance. It's that **every fix has to be applied six times and one of them will get missed.** That's not hypothetical — it's the direct blocker on Tier 1–2 item 7: adding retry logic to `graph()` means either editing six files or doing this refactor first. Same for the status-code capture that retry depends on. The next Graph bug, the next Outlook API change, the next timeout tweak — all six times, forever, until this is fixed.

There's also a subtler cost: the six copies have already drifted slightly (token caching lives in module scope in each one, so each function gets its own token cache — six separate token fetches where one would do).

### Steps

1. **Create `lib/graph.js`** exporting `getGraphToken()`, `graph(token, path, method, body)`, and a new `graphAbsolute(token, url)` for `@odata.nextLink` following (needed by Tier 1–2 item 5). Move the module-level `cachedToken` / `tokenExpiry` here so all callers share one cache.
   - While you're in here, capture the HTTP status onto thrown errors (`err.status = res.status`) and the `Retry-After` header. This is the prerequisite for item 7 in the companion doc and costs nothing to do now.
2. **Create `lib/email-parse.js`** exporting `htmlToText()` and `extractBodyFields()`.
   - Diff the four copies before merging. If they've drifted, pick the most correct version deliberately rather than whichever you paste first — a subtle difference in HTML stripping changes what gets embedded into memory.
3. **Create `lib/slack.js`** exporting a `slackPost(channel, text, threadTs, blocks)` and `slackUpdateMessage(...)`. Note `comply-agent.js` already has working versions including the three-step file upload flow — lift those rather than rewriting.
4. **Create `lib/supabase.js`** exporting the configured client, replacing the `createClient(...)` call repeated at the top of nearly every file.
5. **Create `lib/claude.js`** with a thin `callClaude({ model, system, messages, tools, maxTokens })` wrapper. Centralizing this means the model string `'claude-sonnet-4-6'` — currently hardcoded in at least six places — lives in one constant, so upgrading models later is a one-line change instead of a scavenger hunt.
6. **Migrate one file at a time, deploying between each.** Start with the lowest-risk backfill script (`backfill-sent-mail.js`), confirm it still works against production, then proceed. Do `inbox-assistant.js` and `digest.js` last — they're the ones you'd notice breaking.
7. **Delete the old copies as you go.** Leaving them "just in case" guarantees someone edits the dead one.

### Verification

- After each file: run its endpoint against production with your `CRON_SECRET` and confirm identical output to before. For the backfills, compare row counts before and after.
- `grep -c "async function getGraphToken" pages/api/*.js` should return zero matches when you're done.
- Confirm token caching actually shares now — you should see fewer auth calls to `login.microsoftonline.com` in the logs during a maintenance run.
- Run `npm run smoke:memory` (the existing smoke test) after each migration.

**Rollback plan:** each file migrates independently, so any single failure reverts by restoring one file. Don't do this as one giant commit.

---

## 11. Stand up a real test suite and CI

**Effort:** 2–3 days for the foundation, then ongoing · **Risk:** low · **Value:** highest on this list

### What's wrong

There is essentially no testing. The complete inventory:

- `scripts/smoke-memory-status.mjs` — hits the live `/api/memory-status` endpoint and asserts 7 tables return finite counts. Useful, but it tests a deployed system, not code, and covers one endpoint.
- `.github/workflows/claude-code-review.yml` — Claude reviews PRs.
- `.github/workflows/claude.yml` — Claude responds to `@claude` mentions.

Neither workflow runs tests, because there are none to run. There's also **no linter at all** — no `eslint` dependency, no `.eslintrc`, no `lint` script in `package.json`.

So today: a change that breaks the digest ships, and you find out when no digest arrives the next morning — or worse, when a subtly wrong digest arrives and you trust it.

### What "core user flow" means for this system

Your standard practice calls for an end-to-end test of the app's primary feature. There's no web UI here, so the equivalent flows are:

1. **Slack message → agent → draft created → nothing sent.** This is the main event.
2. **Email batch → digest triage → correctly bucketed Slack post.**
3. **Violation report → three approved sections → PDF generated.**

All three are testable end-to-end with mocked external services, because every external dependency in this system is an HTTP call.

### Steps

**Phase A — foundation (half a day)**

1. Add `vitest` and `msw` (Mock Service Worker v2, which intercepts `fetch` — the right choice since this codebase uses native `fetch` everywhere, not axios).
2. Add `eslint` + `eslint-config-next` and a `lint` script. Next 14 ships `next lint` — you just need the config.
3. Add scripts: `"test": "vitest run"`, `"test:watch": "vitest"`, `"lint": "next lint"`.
4. Build `test/mocks/` with MSW handlers for the four external services:
   - **Microsoft Graph** — token endpoint, message list, message get, createReply, send, move/archive
   - **Anthropic** — returns canned tool-use and text responses
   - **Slack** — `chat.postMessage`, `chat.update`, `conversations.replies`
   - **OpenAI** — embeddings

   Everything must be mocked. No test should ever touch your real inbox, and no test should cost money — that's your stated requirement and it's also what keeps the suite fast enough that you'll actually run it.

**Phase B — the tests that matter most (1 day)**

Priority order, highest value first:

5. **Slack signature verification.** Pure function, no mocking needed, security-critical. Test: valid signature passes; tampered body fails; a timestamp older than 5 minutes fails (replay protection); malformed input doesn't throw. This is the front door to the whole system.

6. **The approval gate** (once Tier 1–2 item 6 is built). Test: a draft request produces a draft and calls no send endpoint; a `Send` button click sends exactly once; **a message instructing the agent to "send it immediately, skip approval" results in zero send calls.** That last one is the test that proves the gate is structural rather than a prompt suggestion — it's the single most valuable test in this suite.

7. **Digest triage classification.** Feed a fixture of ~15 realistic emails (a vendor invoice, a tenant complaint, an AppFolio automation, obvious spam, a lender request with a deadline) and assert bucketing. Since Claude's output isn't deterministic, assert on structure and clear-cut cases: spam is filtered, the deadline email lands in Action Required, the automated notification doesn't. Don't assert exact wording.

8. **Comply-or-Vacate state machine.** The highest-stakes output in the system — these are legal notices. Test: sections are presented one at a time and never bundled; an approved section is never re-drafted; a revision replaces the right section and leaves the others intact; the PDF only generates after all three approvals; the PDF contains the municipality addendum when the property is in Seattle and not when it isn't.

9. **Memory search degradation.** Assert that with `OPENAI_API_KEY` unset, search falls back to keyword-only and still returns results rather than throwing. This is a real production configuration, not a hypothetical.

10. **Retry logic** (once Tier 1–2 item 7 exists). Two 429s then success → three calls with increasing delays. A 404 → exactly one call. `Retry-After` is honored over the default backoff.

**Phase C — the repeated-use tests (half a day)**

Your preference specifically calls out bugs that only appear after several runs — which is exactly where this system's real risks live:

11. **Run the digest twice on the same fixture.** Assert: no duplicate `digest_runs`, no duplicate `email_messages` (the upsert should hold), no duplicate `memory_chunks`. This catches the class of bug where re-running a cron quietly doubles your data.
12. **Run the memory pipeline across several simulated days** and assert `memory_chunks` growth is proportional to new content, not to run count.
13. **Feed 200 emails through the digest** and assert the volume-cap warning fires (Tier 1–2 item 2) and nothing silently truncates.
14. **Run a Comply conversation with two revision rounds** and assert state stays coherent — this is where the concurrency issue in Tier 1–2 item 8 would surface.
15. **Simulate Graph pagination across 4 pages** and assert all items arrive.

**Phase D — CI (2 hours)**

16. Create `.github/workflows/ci.yml`: on push and pull_request, run `npm ci`, `npm run lint`, `npm run build`, `npm run test`. Node 20.
17. Make it a required status check on the default branch so a red build can't merge.
18. Keep `smoke:memory` out of CI (it needs live secrets and a deployed system) — run it as a post-deploy step or manually.

### Verification

The suite verifies itself, but check these:

- `npm run test` completes in under 30 seconds. If it's slower, you'll stop running it.
- Deliberately break something obvious — remove the timestamp check from signature verification — and confirm a test goes red. A suite that never fails isn't testing anything.
- Confirm no test makes a real network call: run with networking disabled and everything should still pass.
- Open a throwaway PR and confirm CI runs and reports.

### One caution

Don't chase coverage percentage. Fifteen tests covering the send gate, the triage buckets, the legal-notice state machine, and the re-run safety are worth more than 200 tests covering string helpers. The goal is confidence in the paths where a bug costs you money or credibility.

---

## 12. Close the loop on the draft-response learning system

**Effort:** 3–5 days · **Risk:** high (this one sends email) · **Prerequisites:** Tier 1–2 item 6, and item 11 above — both non-negotiable

### What's already built

More than you'd expect. This is genuinely 70% done:

**`backfill-draft-candidates.js`** is the most sophisticated script in the repo. It builds per-contact relationship stats from up to two years of history — `inbound_count`, `outbound_count`, `back_and_forth_thread_count` — then flags a recent inbound email as a draft candidate only when the sender is external, has at least 2 prior back-and-forth threads, and the text matches response-seeking patterns (`?`, "let me know", "please", "confirm") while *not* matching non-response patterns (no-reply senders, "FYI", "for your records", automated-report language). That's a real relationship model, not a keyword filter.

**The schema is in place** (`supabase/migrations/013_draft_response_memory.sql`):
- `draft_response_candidates` — with `status`, `known_contact_score`, the three relationship counts, `reason`, `context_summary`, `draft_graph_message_id`
- `draft_feedback` — with `original_draft`, `user_feedback`, `revised_draft`, `extracted_guidance`, `sender_email`, indexed on `(owner_email, sender_email, created_at desc)`

**The capture path works.** `recordDraftFeedback` (`inbox-assistant.js:1752`) writes your corrections and — importantly — mirrors the extracted guidance into `memory_chunks` with `source_type: 'draft_feedback'` (`:1795`), so past corrections are already retrievable by the agent's semantic search. And lifecycle status is tracked: `markDraftCandidateByDraftId` flips candidates to `sent` (`:1905`) or `dismissed` (`:1962`).

### What's missing

Nothing *consumes* the accumulated signal proactively. The system records that you accepted 9 of 10 drafts to a particular vendor and rewrote every draft to your attorney — and then waits for you to ask. The feedback loop captures and stores but never acts.

Concretely, three gaps: there's no per-sender aggregation of accept/reject history; nothing drafts before you ask; and there's no confidence model deciding *which* senders are safe to draft for.

### Steps

**Phase A — measure before you automate (1 day)**

1. Build a per-sender profile from existing data. `draft_response_candidates.status` already gives you accept (`sent`) versus reject (`dismissed`) per sender, and `draft_feedback` gives you "accepted but needed rewriting." Aggregate into a view or table: sender, drafts offered, sent as-is, sent after edits, dismissed, and the accumulated `extracted_guidance` for that contact.
2. **Look at the data before building anything on it.** If no sender has 10+ data points yet, you don't have enough signal for auto-drafting and Phase B is premature — keep collecting. This step exists to stop you from automating on the basis of four examples.
3. Add these counts to `memory-status.js` so you can watch the signal accumulate.

**Phase B — auto-draft with a confidence gate (2 days)**

4. Define an explicit eligibility rule and write it down. Something like: draft automatically only when the sender has ≥5 prior drafts, ≥80% sent, none dismissed in the last 30 days, and the contact is not in an excluded category.
5. **Hard-exclude by category regardless of statistics.** Lenders, attorneys, insurance carriers, government and regulatory senders, and any first-contact sender — never auto-draft for these, no matter how good the numbers look. The `entities` table already carries type metadata to key this off. The system prompt already draws this line for tone ("informality only with known collaborators, never lenders or legal counsel"); this makes it structural.
6. Add a cron (or extend `memory-maintenance.js`) that generates drafts for eligible candidates, using `search_memory` for thread context and pulling that sender's `draft_feedback` guidance into the prompt so past corrections actually shape the new draft.
7. **Post every auto-draft behind the approval buttons from Tier 1–2 item 6.** No exceptions, no "high confidence sends automatically" tier. The value here is that the draft is already written when you look at it — not that it goes out unattended. That distinction is what keeps this feature safe.
8. Cap volume: no more than 3–5 auto-drafts per day to start. If they're bad, you want to discover that across five messages, not fifty.

**Phase C — learn from the outcome (1 day)**

9. Every send, edit, or discard on an auto-draft feeds back into the same tables — the loop closes on itself.
10. Track a simple weekly metric: what percentage of auto-drafts were sent unedited? If it's climbing, the guidance extraction is working. If it's flat or falling, the drafts are generic and you should re-examine what context the prompt is actually receiving.
11. Add a kill switch — an env var like `AUTO_DRAFT_ENABLED` — so you can turn it off from the Vercel dashboard in seconds without a deploy.

### Verification

- **Before any auto-draft reaches Slack:** run it in shadow mode for a week. Generate the drafts, write them to a table, don't post them. Read them yourself and judge whether you'd have sent them. This is the step worth not skipping.
- Confirm an excluded-category sender never produces an auto-draft even with a perfect statistical record — test with a real lender address.
- Confirm the daily cap holds.
- Confirm a discarded auto-draft correctly lowers that sender's eligibility.
- Confirm the kill switch works without a redeploy.

### The honest risk assessment

This is the only item across both documents that can cause real damage. An auto-drafted reply that goes out with wrong information to a lender or an owner is a different category of problem from a missed digest. The mitigations that matter: mandatory human approval on every send with no exception tier, category exclusions that override statistics, a shadow-mode period before anything is posted, a hard volume cap, and a kill switch.

Build it only after the approval gate is real and the test suite exists. Both prerequisites are listed for a reason — this feature makes the system write more email on your behalf, so the wall in front of sending needs to be structural first.

---

## Rollup

| # | Item | Effort | Risk | Prerequisites |
|---|---|---|---|---|
| 10 | Consolidate duplicated helpers | 1–2d | medium | — |
| 11 | Test suite + CI | 2–3d | low | 10 (ideally) |
| 12 | Draft-learning auto-draft | 3–5d | **high** | Tier 1–2 #6, and #11 |

**Total: roughly two to three focused weeks**, and unlike Tier 1–2 this doesn't need to be done in one stretch. Items 10 and 11 are foundation work that pays back on every subsequent change; item 12 is a discretionary feature that should wait until the foundation is under it.

### Sequencing across both documents

If you're planning the whole program, the order I'd suggest is:

1. **Tier 1 items 1–4** — cheap, safe, removes quiet risk immediately
2. **Tier 3 item 10** — consolidation, so everything after is edited once instead of six times
3. **Tier 3 item 11** — the test suite, so everything after has a safety net
4. **Tier 1–2 items 7, 8, 5** — retry, concurrency, pagination, now cheap because of step 2 and safe because of step 3
5. **Tier 1–2 item 6** — the hard approval gate
6. **Tier 1–2 item 9** — proactive forgotten-items nudge
7. **Tier 3 item 12** — auto-drafting, last, on top of everything else

That ordering front-loads the work that makes later work cheaper, and puts the one genuinely risky feature at the end where it has the most protection under it.
