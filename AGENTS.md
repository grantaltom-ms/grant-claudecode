# AGENTS.md

## Cursor Cloud specific instructions

This repo is a **monorepo with three independent apps plus Python ETL scripts**, all oriented around the "Milestone Properties" domain and a shared Supabase/Postgres backend. The apps do not import each other and each has its own dependency set. The update script installs all dependencies (`npm install` at the root, `npm install` in `underwriting/`, and `pip install -r requirements.txt`).

### Services and how to run them

| Service | Dir | Dev command | Port | Notes |
|---|---|---|---|---|
| Inbox Assistant (Next.js, API-only) | repo root | `npm run dev` | 3000 | No pages UI — only `pages/api/*` routes. `GET /` returns 404 by design; that still means the server is up. |
| Underwriting SPA (React 19 + Vite) | `underwriting/` | `npm run dev` | 5174 | Port is pinned in `underwriting/vite.config.js`. Fully client-side underwriting math works offline. |
| Financial Agent (Flask) | repo root | `python3 app.py` | 5001 (`PORT` env) | Chat UI at `/`. Initializes Anthropic + Supabase clients from env at import. |
| Python ETL scripts | repo root | `python3 import_*.py`, `audit_data.py`, `refresh_views.py` | n/a | `db.py` `get_client()` calls `sys.exit(1)` when `SUPABASE_URL`/`SUPABASE_KEY` are unset — expected without creds. |

### Lint / test / build (see also `.github/workflows/ci.yml`)

- Root Inbox Assistant: `npm run lint`, `npm run test` (Vitest), `npm run build`. The Vitest suite runs **fully offline** — `vitest.config.js` injects dummy env vars and `test/setup.js` starts an MSW mock server (`onUnhandledRequest: 'error'`), so no real credentials or network are needed.
- Underwriting: `npm run lint`, `npm run build` (Vite). No test script exists. Note: `npm run lint` currently reports pre-existing errors (unused vars, react-refresh) in `underwriting/src`; the app still builds and runs. These are not environment issues.
- Python apps have no test suite or linter configured.

### Credentials / what works without them

None of the apps can run their *external* actions without secrets, but plenty is exercisable offline:

- **Runs with no secrets:** root Vitest suite (offline), root `next dev` server (routes compile; API routes return 500 with `supabaseUrl is required` until Supabase env vars are set), and the **underwriting SPA end-to-end** (NOI, cap rate, cash-on-cash, DSCR, IRR, investment grade, proforma, and sensitivity tables all compute client-side).
- **Needs secrets:** the Inbox Assistant API routes and digest cron (`ANTHROPIC_API_KEY`, `AZURE_*` Graph creds, `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, `SLACK_*`, `CRON_SECRET`); the Flask Financial Agent chat (`ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_KEY`, and `ZAP_OUTLOOK_DRAFT`/`ZAP_SLACK_MESSAGE` for comms); and the Python ETL scripts (`SUPABASE_URL`, `SUPABASE_KEY`). See `SETUP.md` for the full env-var table.
- The underwriting SPA has a **hardcoded** Supabase URL + anon key in `underwriting/src/lib/supabase.js`; only the "Save to Database" and "Generate with Claude" (Supabase Edge Function) buttons depend on that backend being reachable — core underwriting does not.

### Gotchas

- `app.py` reads `SUPABASE_SCHEMA_REFERENCE.md` at import time; run it from the repo root so the relative path resolves.
- CI uses Node 20; the environment ships Node 22, which works for dev/build/test here.
