# Inbox Memory Architecture

The Vercel inbox assistant now has a durable memory pipeline:

1. Microsoft Graph ingestion saves Outlook messages into `email_messages`.
2. Thread rollups save conversation state into `email_threads`.
3. Digest runs map Slack item numbers to Graph messages via `digest_runs` and `digest_items`.
4. Entity extraction writes durable people, vendors, properties, invoices, insurance, financial statements, and issue records into `entities` and `entity_mentions`.
5. Full-body and attachment backfills enrich `email_messages`, `email_attachments`, and `memory_chunks`.
6. Operational extraction writes projects, decisions, commitments, and open loops.
7. Context card backfills write compact summary records into `context_cards`.
8. The Slack assistant searches compact cards first with `search_context_cards`, falls back to `search_memory` for source detail, then narrows with entity/thread tools.

## Protected Operations

All maintenance endpoints require `Authorization: Bearer $CRON_SECRET`.

- `/api/memory-status`
- `/api/backfill-inbox`
- `/api/backfill-email-bodies`
- `/api/backfill-attachments`
- `/api/backfill-entities`
- `/api/backfill-memory-chunks`
- `/api/backfill-operational-memory`
- `/api/backfill-context-cards`

Run:

```bash
CRON_SECRET=... npm run smoke:memory
```

## Search Modes

Retrieval is live in three layers:

- Compact card search works through `context_cards` and should be the first lookup for known contacts, properties, projects, owner/investor facts, operating context, commitments, and open loops.
- Full-text/trigram search works now through `memory_chunks.search_vector`.
- Vector search is schema-ready through `memory_chunks.embedding vector(1536)`.

Set `OPENAI_API_KEY` in Vercel to activate embeddings for new chunk backfills and assistant searches.

## Layered Memory

The memory stack is intentionally layered to control token cost:

- Raw data: `email_messages`, `email_attachments`, `digest_items`, and source Supabase tables.
- Chunk layer: `memory_chunks`, used for source detail and hybrid retrieval.
- Summary layer: `context_cards`, used for compact durable profiles and active operating context.
- Active layer: `open_loops`, `commitments`, `draft_response_candidates`, and `daily_priority_suggestions`.

Assistant operations should start with the summary and active layers, then drill into `memory_chunks` or raw email/document records only when the compact context is insufficient.

## Trust Layer

Memory-backed answers should include enough trust context to keep the assistant useful without making Slack noisy:

- Treat raw records as evidence and compact records as business memory. Email bodies, attachments, WhatsApp exports, Slack messages, AppFolio reports, and deployment logs should remain source evidence; `context_cards`, `open_loops`, `commitments`, and related records are the operational interpretation.
- Search compact memory first. Use `context_cards` for known people, properties, projects, owner/investor facts, and open operating context; use `memory_chunks` or raw records only when source-level detail is needed.
- Carry confidence metadata through retrieval. Tool results should expose source systems, evidence count, last verified date, confidence hint, and missing source-of-truth checks when possible.
- Keep Slack short. Slack should show the answer, next action, and a concise evidence/confidence note; richer details belong in Supabase logs, memory records, or follow-up retrieval.

Source-of-truth roles:

- AppFolio: current property, tenant, accounting, and ledger status.
- Email: conversation history, requests, promises, and attachments.
- WhatsApp: informal work conversation history for approved work contacts.
- Slack: team communication, approvals, and bot workflow state.
- Supabase: assistant memory, summaries, open loops, commitments, context cards, and run logs.
- GitHub: code and repository history.
- Vercel: deployed app and runtime configuration state.

## Safety Defaults

The digest no longer archives model-classified spam by default. It filters suspected spam/noise from the digest and records that behavior in digest metadata. Set `AUTO_ARCHIVE_SPAM=true` only if direct archive behavior is explicitly desired.

## Security

Inbox-memory tables have RLS enabled and public/client grants revoked from `anon` and `authenticated`. Server routes use the Supabase service role key.
