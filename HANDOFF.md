# Memex — Session Handoff

**Repo:** `cdburgess75/Memex`
**Active branch:** `claude/url-request-GwwHe`
**Server:** Ubuntu machine at `192.168.1.32` (LAN) — Docker not yet installed

---

## What Memex Is

A self-hosted, LLM-assisted team knowledge base. Single static `index.html` frontend served by a Node.js/Express backend. No build step. Key capabilities:
- **Ingest** content from URLs, file uploads (PDF/DOCX/XLSX/CSV/TXT/MD), or paste
- **Query** the knowledge base with AI (streaming SSE answers)
- **Lint** — AI audits the knowledge base for gaps, contradictions, orphaned pages
- **Files** — upload, preview, edit Office files (WOPI/Office Online) and Google Docs natively in browser
- **Admin panel** — full UI for all settings, no config files needed after initial deploy

---

## Architecture

```
Browser (index.html)     — vanilla JS SPA, no framework, no build
    │  Keycloak OIDC     — PKCE auth flow, Google + Microsoft SSO
    │  Fetch API
    ▼
Node.js / Express  (server/)
    ├─ /api/config           — returns Keycloak URL/realm/clientId to browser
    ├─ /api/auth/me          — current user id, email, role, name
    ├─ /api/pages            — page CRUD, full-text search, version history
    ├─ /api/ai               — ingest · query (SSE) · lint (SSE) · extract
    ├─ /api/files            — upload, signed URLs, Office Online, Google Drive
    ├─ /api/log              — activity log
    ├─ /api/admin            — stats, users, roles, usage/cost dashboard
    ├─ /api/admin/settings   — runtime settings GET/PUT (admin only)
    └─ /wopi                 — WOPI protocol for Office Online editing
    │
    └─ Postgres (via pg / node-postgres)
         pages, page_versions, activity_log, user_roles,
         api_usage, documents, system_settings
```

---

## Auth Flow (Keycloak OIDC PKCE)

1. Browser generates PKCE verifier + challenge, stores in `sessionStorage`
2. Redirects to Keycloak with `kc_idp_hint=google|microsoft`
3. Keycloak handles IdP login, redirects back with `?code=...`
4. Browser exchanges code for tokens at Keycloak `/token`
5. Tokens stored in `localStorage`: `memex_access_token`, `memex_refresh_token`, `memex_token_exp`
6. `getToken()` silently refreshes when near expiry
7. Server middleware (`server/middleware/auth.js`) verifies JWT via Keycloak JWKS (cached 10 min)
8. First login auto-assigns `admin` (if email in `ADMIN_EMAILS`) or `contributor`

**Two Keycloak URL env vars:**
- `KEYCLOAK_URL` — browser-visible (e.g. `http://192.168.1.32:8080`)
- `KEYCLOAK_INTERNAL_URL` — server-to-server JWKS (e.g. `http://keycloak:8080` in Docker)

---

## Key Files

| File | Purpose |
|---|---|
| `index.html` | Entire frontend — ~2800 lines of vanilla JS |
| `server/index.js` | Express app, dynamic CORS + trust proxy middleware |
| `server/lib/db.js` | Postgres pool — `query()` and `queryOne()` helpers |
| `server/lib/settings.js` | Runtime settings — DB-backed, 30s cache, env var fallback |
| `server/lib/storage.js` | Storage abstraction — local / S3 / Supabase |
| `server/lib/encryption.js` | AES-256-GCM encrypt/decrypt — used by local storage |
| `server/lib/wopiTokens.js` | In-memory WOPI access tokens + file locks |
| `server/middleware/auth.js` | Keycloak JWT verification + role lookup |
| `server/middleware/requireRole.js` | Role enforcement middleware |
| `server/routes/ai.js` | Ingest, query (SSE), lint (SSE), extract |
| `server/routes/pages.js` | Page CRUD + search + versions |
| `server/routes/files.js` | File upload, download, WOPI, Google Drive |
| `server/routes/settings.js` | Admin settings GET/PUT — masks sensitive values |
| `server/routes/admin.js` | Stats, user list, role management, API usage |
| `server/routes/wopi.js` | WOPI protocol handlers |
| `postgres/init/01_schema.sql` | Full standalone Postgres schema (no Supabase FK deps) |
| `postgres/init/00_keycloak_db.sh` | Creates `keycloak` DB on first boot |
| `keycloak/memex-realm.json` | Keycloak realm import — memex realm, memex-app PKCE client |
| `docker-compose.yml` | Postgres 16 + Keycloak 24 + app — one command startup |
| `.env.example` | All env vars documented with defaults |

---

## Settings System

All runtime config lives in the `system_settings` Postgres table, accessed via
`server/lib/settings.js`. Falls back to env vars. 30-second in-memory cache.
All of the below are configurable from the admin panel UI — no server restart needed
(except where noted).

### AI
- `anthropic_api_key` → `ANTHROPIC_API_KEY` *(sensitive)*
- `anthropic_model` → `ANTHROPIC_MODEL` (default: `claude-sonnet-4-6`)

### Storage
- `storage_provider` → `STORAGE_PROVIDER` (`local` | `s3` | `supabase`)
- `storage_local_path` → `STORAGE_LOCAL_PATH`
- `storage_s3_bucket` / `region` / `endpoint` / `force_path_style`
- `storage_s3_access_key_id` *(sensitive)* / `storage_s3_secret_access_key` *(sensitive)*
- `supabase_url` / `supabase_service_role_key` *(sensitive)*
- `storage_encryption_key` → `STORAGE_ENCRYPTION_KEY` *(sensitive — AES-256-GCM)*

### Integrations
- `app_url` → `APP_URL` (required for WOPI + local signed URLs)
- `google_drive_folder_id` / `google_service_account_key` *(sensitive)*

### Network
- `bind_address` → `BIND_ADDRESS` *(restart required)*
- `trust_proxy` → `TRUST_PROXY` (`1` | `loopback` | `linklocal` | `true`)
- `cors_origins` → `CORS_ORIGINS` (comma-separated or `*`)
- `http_proxy` → `HTTP_PROXY` *(restart required)*
- `max_upload_mb` → `MAX_UPLOAD_MB` (default: 50)

---

## Admin Panel Sections

1. **Dashboard** — API usage/cost, file storage stats, page count, contributors, activity
2. **Team** — all logged-in users + role management dropdown
3. **System Settings:**
   - Artificial Intelligence (model, API key)
   - File Storage (provider + conditional fields for local/S3/Supabase)
   - At-rest Encryption (AES-256-GCM key with Generate button)
   - Integrations (App URL, Google Drive)
   - Network & Security (bind, proxy trust, CORS, outbound proxy, upload limit)

---

## Encryption

- **Local storage:** AES-256-GCM applied before write / after read in `storage.js`
- Wire format: `MAGIC(4) + IV(12) + AUTH_TAG(16) + CIPHERTEXT`
- Key: 64-char hex string (verbatim 32 bytes) OR any passphrase (scrypt-derived)
- Backward compatible: files without the magic header are served as-is
- Key loss = encrypted files unrecoverable (documented in UI)
- **S3:** use bucket-level SSE — handled by AWS, not the app

---

## Test Suite

**58 tests, all passing.** Run: `cd server && npm test`

| File | Tests | Covers |
|---|---|---|
| `__tests__/lib/encryption.test.js` | 16 | Round-trips, key resolution, backward compat, GCM tamper detection |
| `__tests__/lib/settings.test.js` | 8 | DB/env precedence, cache hits, set/delete, DB-down fallback |
| `__tests__/middleware/requireRole.test.js` | 4 | Allow/deny by role |
| `__tests__/middleware/auth.test.js` | 8 | 401 paths, user attachment, auto-role assignment |
| `__tests__/routes/pages.test.js` | 14 | GET/search/PUT/DELETE, role enforcement, DB errors |
| `__tests__/routes/settings.route.test.js` | 8 | GET masking, PUT sentinel guard, unknown keys, admin-only |

Stack: Jest 29 + Supertest. Coverage: `npm run test:coverage`

---

## Deployment (Ubuntu + Docker)

```bash
# 1. Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker

# 2. Clone and switch to the working branch
git clone https://github.com/cdburgess75/Memex.git
cd Memex
git checkout claude/url-request-GwwHe

# 3. Configure
cp .env.example .env
nano .env
# Required: ANTHROPIC_API_KEY, ADMIN_EMAILS, POSTGRES_PASSWORD,
#           KEYCLOAK_ADMIN_PASSWORD, KEYCLOAK_URL=http://192.168.1.32:8080,
#           APP_URL=http://192.168.1.32:3000

# 4. Start
docker compose up -d

# 5. Check logs
docker compose logs app --tail=30
```

### After First Boot — Keycloak Client Config (required for login)

1. Go to `http://192.168.1.32:8080` → Administration Console
2. Realm: **memex** → Clients → **memex-app**
3. **Valid redirect URIs:** add `http://192.168.1.32:3000/*`
4. **Web origins:** add `http://192.168.1.32:3000`
5. Save

App available at: **http://192.168.1.32:3000**

---

## Open GitHub Issues (Future Work)

| # | Title | Priority |
|---|---|---|
| #5 | SharePoint / OneDrive storage provider | High |
| #6 | Tiered storage hot/cold migration | Medium |
| #7 | CDN integration (Cloudflare, CloudFront) | Medium |
| #8 | Encryption at rest / BYOK for S3 (client-side before upload) | High |
| #9 | ZFS / TrueNAS deployment guide | Low |

---

## Immediate Next Steps

1. Get the server running — install Docker, clone repo, set `.env`, `docker compose up -d`
2. Configure Keycloak — add redirect URIs for `192.168.1.32:3000`
3. First login — verify admin panel loads and settings save correctly
4. Merge branch — open PR from `claude/url-request-GwwHe` → `main` once validated
5. Pick next feature — SharePoint storage (#5) or S3 BYOK encryption (#8)

---

## Resuming in a New Session

Point Claude at this file and the repo:

> "I'm continuing work on the Memex project. Repo is cdburgess75/Memex,
> active branch is claude/url-request-GwwHe. Read HANDOFF.md for full context."
