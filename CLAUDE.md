# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
cd server && npm install

# Run the server (requires .env — copy from .env.example)
node server/index.js

# Run with auto-restart on file changes
cd server && npm run dev
```

There are no tests yet (tracked in GitHub issue #1 and related). There is no build step — the frontend is a single static HTML file served directly by Express.

## Architecture

```
Browser (index.html)          — single-file SPA, no framework, no build tool
    │  Supabase JS SDK        — handles Google / Microsoft SSO and JWT issuance
    │  Fetch API              — all data calls go through the Node server
    ▼
Node.js / Express  (server/)
    ├─ /api/config            — public: returns SUPABASE_URL + SUPABASE_ANON_KEY
    ├─ /api/auth/me           — returns current user id, email, role, name
    ├─ /api/pages             — page CRUD + full-text search + version history
    ├─ /api/ai                — Anthropic API proxy (ingest · query · lint · extract)
    ├─ /api/files             — document upload, signed URLs, Office Online, Google Drive
    ├─ /api/log               — activity log reads
    ├─ /api/admin             — stats, user list, role management, usage/cost dashboard
    └─ /wopi                  — WOPI protocol for Office Online in-browser editing
    │
    └─ Supabase (Postgres + Auth + Storage)
           pages, activity_log, user_roles, page_versions, api_usage, documents
```

### Auth flow

Every request (except `/api/config`) passes through `server/middleware/auth.js`, which:
1. Extracts the Bearer JWT from `Authorization` header
2. Verifies it via `adminClient.auth.getUser(token)` (Supabase service-role client)
3. Looks up the user's row in `user_roles`; if absent, auto-assigns `admin` (if email is in `ADMIN_EMAILS`) or `contributor` using an upsert to avoid race conditions
4. Attaches `{ id, email, role, user_metadata }` to `req.user`

Role enforcement for specific routes uses `server/middleware/requireRole.js`, e.g. `requireRole('admin', 'contributor')`.

### AI operations

All three AI operations live in `server/routes/ai.js`:

- **Ingest** (`POST /api/ai/ingest`) — accepts `{ source?, url?, focus? }`. If `url` is provided, `fetchUrl()` strips HTML with cheerio and extracts the main text. Sends to Claude with a strict JSON-response prompt; the response is parsed and upserted into `pages`. Returns `{ summary, pages[] }`.
- **Query** (`POST /api/ai/query`) — SSE streaming via `anthropic().messages.stream()`. Detects a `SAVE_AS: Title | category` sentinel at the end of the stream and auto-creates a page if present.
- **Lint** (`POST /api/ai/lint`) — same SSE pattern, audits the full page context for contradictions, orphans, and gaps.

The model is set via `ANTHROPIC_MODEL` env var (default `claude-sonnet-4-6`). Token usage is recorded to `api_usage` after every non-streaming call.

### Pages data model

`pages.id` is a user-readable kebab-slug (e.g. `machine-learning-ops`), not a UUID. The AI generates these slugs. `PUT /api/pages/:id` is an upsert — it creates or updates by slug. Before updating, the old content is snapshotted to `page_versions`.

`[[Page Title]]` cross-links in markdown are rendered client-side by `renderMarkdown()` in `index.html` into `<a class="cross-link" data-page="...">` elements. Clicking calls `gotoTitle()`, which looks up the matching page by title in the local `state.pages` array.

### Frontend state

`index.html` is ~2500 lines of vanilla JS. Key globals:
- `state.pages` — in-memory array of all pages, loaded once on login and updated on mutations
- `state.activePage` — currently viewed page id
- `currentUser` — `{ id, email, role, name }` from `/api/auth/me`
- `ingestMode` — `'paste' | 'url' | 'file'`
- `filesList` — documents loaded on Files tab open
- `_streamController` — AbortController for cancelling SSE streams (Query / Lint)
- `_ingestController` — AbortController for cancelling in-flight ingest fetches

### File handling

`server/routes/files.js` handles two separate pipelines:
1. **Direct upload** — multer stores file in memory → uploads via storage abstraction → inserts metadata row in `documents`
2. **File ingest** — downloads file from storage → `extractText()` → runs the same Claude ingest prompt as `ai.js`

`extractText()` caps output at 100 KB to prevent memory issues on large files. Supported formats: `.docx` (mammoth), `.xlsx/.xls/.csv` (SheetJS), `.pdf` (pdf-parse), `.txt/.md` (raw buffer).

### Storage abstraction

`server/lib/storage.js` is a provider-agnostic layer selected by `STORAGE_PROVIDER` env var. All file routes use it — no direct Supabase storage calls anywhere in the codebase.

| Provider | `STORAGE_PROVIDER` value | Notes |
|----------|--------------------------|-------|
| Supabase Storage | `supabase` (default) | Uses existing bucket; best for small deployments |
| Local filesystem | `local` | Set `STORAGE_LOCAL_PATH`; iSCSI/NAS/NFS mounts work transparently |
| S3-compatible | `s3` | AWS S3, Cloudflare R2, Backblaze B2, MinIO, DigitalOcean Spaces |

**Local provider**: Instead of signed URLs, generates short-lived tokens stored in-memory and serves files via `GET /api/files/local-download?token=...` (no auth middleware — the token is the credential, same model as signed URLs).

**S3 provider**: Uses `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` (lazy-required). Set `STORAGE_S3_ENDPOINT` for non-AWS providers; set `STORAGE_S3_FORCE_PATH_STYLE=true` for MinIO.

### WOPI (Office Online editing)

`server/lib/wopiTokens.js` maintains two in-memory Maps: short-lived access tokens (1 hr) and file locks (30 min). Tokens are generated when the browser requests `/api/files/:id/office`, then passed to Microsoft's Office Online iframe as `access_token`. A `setInterval` cleans up expired entries every 15 minutes.

This only works in production when `APP_URL` is set to a public HTTPS URL that Microsoft's servers can reach.

### Database migrations

Run all six in order in the Supabase SQL Editor before first use:

| File | What it creates |
|------|----------------|
| `001_initial.sql` | `pages`, `activity_log`, RLS policies |
| `002_roles.sql` | `user_roles` table |
| `003_full_text_search.sql` | `content_fts` generated column, `search_pages` RPC |
| `004_page_versions.sql` | `page_versions` table |
| `005_api_usage.sql` | `api_usage` table |
| `006_documents.sql` | `documents` table, `documents` storage bucket |

### Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_ANON_KEY` | Yes | Public key for browser-side Supabase client |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Secret key used server-side only |
| `ANTHROPIC_API_KEY` | Yes | Shared across all users |
| `ANTHROPIC_MODEL` | No | Defaults to `claude-sonnet-4-6` |
| `ADMIN_EMAILS` | No | Comma-separated; first-login auto-assignment |
| `PORT` | No | Defaults to `3000` |
| `APP_URL` | No | Public HTTPS URL; required for WOPI editing |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | No | Full JSON blob; required for Google Drive editing |
| `GOOGLE_DRIVE_FOLDER_ID` | No | Target folder for Drive uploads |
| `STORAGE_PROVIDER` | No | `supabase` (default), `local`, or `s3` |
| `STORAGE_LOCAL_PATH` | If local | Absolute path on the host filesystem |
| `STORAGE_S3_BUCKET` | If s3 | Bucket name |
| `STORAGE_S3_REGION` | If s3 | Defaults to `us-east-1` |
| `STORAGE_S3_ACCESS_KEY_ID` | If s3 | Access key |
| `STORAGE_S3_SECRET_ACCESS_KEY` | If s3 | Secret key |
| `STORAGE_S3_ENDPOINT` | If s3 (non-AWS) | Custom endpoint URL |
| `STORAGE_S3_FORCE_PATH_STYLE` | If s3 (MinIO) | Set `true` for path-style addressing |
