# CLAUDE.md

Guidance for Claude Code when working in this repository.

**Depot** (package name `memex`) is a self-hosted document workspace sold commercially to small businesses: a file library with folders, sharing, in-browser Office editing, external storage connectors, A/V meetings, notifications, an AI assistant, and a compliance/admin surface. It is deployed as a Docker stack (app + Postgres + Keycloak + Collabora, fronted by Caddy) onto customer boxes.

## Commands

```bash
cd server && npm install     # install backend deps
cd server && npm start       # run the server (node index.js) — needs ../. env
cd server && npm run dev      # run with --watch auto-restart
cd server && npm test         # jest + supertest (55 suites under server/__tests__/)
node --check server/routes/<file>.js   # syntax-check a route after editing
```

There **is** a test suite — `server/__tests__/` (lib / middleware / routes / integration), run with `npm test`. Don't assume "no tests."

## Hard constraints (read before editing)

- **No build step.** `index.html` is a single ~9,500-line static file served directly by Express — one `<style>` and one ~6,700-line `<script>`, plain globals + functions, no framework, no bundler. This is a deliberate, locked decision. After editing the script, parse-check it: extract the largest `<script>` block and run `new Function(block)`.
- **Releasing bumps `VERSION`.** Cut releases with `./release.sh` (writes `VERSION`, commits, tags `vYYYY.MM.DD.NNN`, pushes → GitHub Actions publishes a pinned GHCR image). The deploy path (`upgrade.sh` / the box's `ring-update.sh`) is version-gated, so the tag and `VERSION` must match.
- **Escaping.** User-controlled strings go through `esc()` (text/attribute) in `index.html`. `esc()`/`escAttr()` are correct for HTML text and attribute contexts, but **do NOT** protect a value interpolated into an inline `onclick="fn('...')"` JS-string — use `data-*` attributes read via `this.dataset.*` for dynamic handler args.
- **Secrets never enter the public repo.** `.env`, `secrets/`, `keys/` (except the public license key), and the license signing key stay out of git.

## Architecture

```
Browser — index.html (single-file SPA, OIDC Code+PKCE against Keycloak, all data via fetch)
   │  access/refresh tokens in localStorage; getToken() silently refreshes
   ▼
Node/Express — server/
   ├─ index.js            composition root (~350 lines): CORS, rate limits, security
   │                      headers, Collabora proxy, migrations-before-listen, /healthz
   ├─ routes/  (18 routers) auth, files (+ files/folders.js domain sub-router,
   │                      mounted at /api/files/folder), ai, log, security, admin,
   │                      admin/settings, notifications, preferences, libraries,
   │                      version, license, setup, meetings, backup, connectors, csp-report
   ├─ lib/     (~47 modules) db, settings, storage, migrations, auditLog, wopiTokens,
   │                      documentAccess, documents (createDocumentRecord/DOCUMENT_COLUMNS),
   │                      fileEvents, shareLinks, connectors/, aiProviders, emailEvents, …
   └─ middleware/         auth.js (JWKS verify + role auto-provision), requireRole.js
        │
        ├─ Postgres (via pg)   documents, folders, shares, libraries, user_roles,
        │                      system_settings, notifications, audit log, …
        ├─ Keycloak (OIDC)     identity + SSO (Google / Microsoft / LDAP via Keycloak)
        └─ Collabora (WOPI)    in-browser Office editing, same-origin proxied
```

`routes/files.js` is the large one (~2,300 lines, 50 routes) spanning documents, shares, chunked/encrypted uploads, Collabora discovery, and the AI "ask." Treat it as the highest-churn file. **ST-1 is splitting it into domain sub-routers, one per release** — the folder operations (create/rename/delete/reparent/move, ZIP, public download links, member ACLs) already live in `routes/files/folders.js`, mounted with `router.use('/folder', …)`. Shared helpers extracted for the sub-routers live in `lib/`: `lib/documents.js` (`createDocumentRecord`, `DOCUMENT_COLUMNS`, `safeDocName`, dedupe/index/notify pipeline), `lib/shareLinks.js` (token/password crypto, client shapes, download tickets, `publicAppBase`), `lib/fileEvents.js` (`logEvent`/`logDocumentEvent`/`requestAuditDetail`). `files.js` re-imports these under their original names and keeps its `module.exports.*` re-exports stable for existing consumers (`index.js`, `admin.js`, tests).

### Auth flow

Standard OIDC **Authorization Code + PKCE**, entirely client-side — no server callback.

1. `signIn(provider)` builds a PKCE verifier/challenge, stores them in `sessionStorage`, redirects to Keycloak (`kc_idp_hint=…` for a specific IdP).
2. Keycloak authenticates and redirects back to `origin?code=…`.
3. `handleOAuthCallback()` exchanges the code at Keycloak's `/token`; access + refresh tokens go to `localStorage` (`memex_access_token`, `memex_refresh_token`, expiry in `memex_token_exp`).
4. `getToken()` returns the access token, silently refreshing near expiry.

Server side (`server/middleware/auth.js`): extract the Bearer JWT, verify RS256 against Keycloak's JWKS (public keys cached ~10 min), read `sub`/`email`, look up `user_roles` (auto-provisioning a role on first login with an audit entry), attach `{ id, email, role, … }` to `req.user`. Role gates use `requireRole('admin', 'contributor')`.

`KEYCLOAK_URL` is the browser-visible URL (returned in `/api/config`); `KEYCLOAK_INTERNAL_URL` is the server→Keycloak URL for JWKS (defaults to `KEYCLOAK_URL`).

### Config & settings

`/api/config` (public, pre-auth) returns branding (`name`, `logo`, `accent`), Keycloak coords (`keycloakUrl`, `keycloakRealm`, `keycloakClientId`), and `version` — consumed by `initApp()` in `index.html`.

`server/lib/settings.js` is the config source of truth: **DB-first** (the `system_settings` table: `key, value, updated_at, updated_by`) with an **env-var fallback** via `ENV_MAP`, behind a **30-second in-memory cache**. Use `settings.getOrEnv(key)`. A raw `UPDATE system_settings …` takes effect within the cache TTL, no restart. To make a setting admin-editable, add it to `ENV_MAP` — `routes/settings.js` exposes every `ENV_MAP` key through the admin GET/PUT (license-trust and updater keys are deliberately excluded so a customer admin can't forge entitlements or turn the updater into an RCE).

### Frontend state (index.html)

Plain top-level globals, no store: `state = { tab, log }`, `currentUser`, `appConfig`, `filesList`, `librariesList`, `fileView`, `currentFolderPath`, `selectedFileIds` / `selectedFolderPaths` (Sets), `fileFilter`, plus localStorage-backed prefs (`memex_accent`, layout, pinned libraries). Views render by assigning `innerHTML` from template-literal builders; mutations call the matching `render*` function. The accent theme is computed at runtime by `applyAccent(hex)` (derives `--accent`/`--accent-soft`/`--accent-wash`/`--accent-ink` from the brand or device-override color).

### Storage

`server/lib/storage.js` is a provider-agnostic layer selected by the `storage_provider` setting: **`local`** (default; `STORAGE_LOCAL_PATH`, works over NAS/NFS/iSCSI mounts) or **`s3`** (AWS/R2/B2/MinIO/Spaces via `@aws-sdk/client-s3`; `STORAGE_S3_ENDPOINT` + `STORAGE_S3_FORCE_PATH_STYLE` for non-AWS). Local files are encrypted at rest (GCM); changing `storage_encryption_key` is guarded server-side because it would orphan existing files. All file routes go through this layer.

### Editing (Collabora, via WOPI)

In-browser Office editing is **Collabora Online**, reached through a **same-origin proxy** (see `index.js` and the WOPI routes). `server/lib/wopiTokens.js` mints short-lived per-file access tokens + locks. The server refuses to derive the WOPI/Collabora host from the client `Host` header (SSRF guard).

### AI

`server/routes/ai.js`: `POST /query` (SSE streaming), `POST /extract`, `GET /models`, `POST /detect-models` (admin), `PUT /active` (admin — switches the workspace-wide model). Multi-provider via `server/lib/aiProviders.js` (Anthropic + OpenAI-compatible endpoints configured in `ai_endpoints`). Default model `claude-sonnet-4-6`; default catalog `claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5`.

### Database & migrations

Postgres via `pg`; all queries go through `server/lib/db.js` (`query`, `queryOne`, `withTransaction`) — **every query is parameterized**. Schema migrations are forward-only ordered `.sql` files in `server/migrations/`, applied once at startup and recorded in `schema_migrations` (`server/lib/migrations.js`); startup aborts if a migration fails. The historical runtime `CREATE TABLE IF NOT EXISTS` (`ensure*Table`) helpers were consolidated into `0004_runtime_ensure_tables.sql` — all schema changes go in migrations.

## Deployment

- `./release.sh [vYYYY.MM.DD.NNN]` — bump `VERSION`, commit, tag, push; the tag triggers the GHCR image build (main also gets `:latest`).
- `./upgrade.sh <tag>` on a host, or the box's healthz-gated `ring-update.sh <tag>` (pre-flight → backup → pull → recreate → migrate → smoke → finalize).
- `docker compose up` brings the full stack up locally (`install.sh` provisions a real deployment and generates strong secrets).

## Environment variables (common)

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres connection string |
| `KEYCLOAK_URL` / `KEYCLOAK_INTERNAL_URL` | Browser-visible / server→JWKS Keycloak URLs |
| `KEYCLOAK_REALM` / `KEYCLOAK_CLIENT_ID` | Default `memex` / `memex-app` |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | Shared key; model defaults to `claude-sonnet-4-6` |
| `STORAGE_PROVIDER` | `local` (default) or `s3` (+ its `STORAGE_S3_*` / `STORAGE_LOCAL_PATH`) |
| `STORAGE_ENCRYPTION_KEY` | At-rest encryption for local files (do not rotate casually) |
| `APP_URL` | Public HTTPS origin |
| `MAX_UPLOAD_MB` / `MAX_UPLOAD_FILES` / `BLOCKED_FILE_EXTS` | Upload limits + refused extensions (all admin-settable) |

Most of these are also settable at runtime in Admin → Settings (they live in `ENV_MAP`); the env var is the fallback when no `system_settings` row exists.
