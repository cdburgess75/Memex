# Memex — Session Handoff

_Last updated: 2026-06-08 · Running version: **v2026.06.08.006**_

## What Memex is
Self-hosted, LLM-assisted team knowledge base **and** file store. Vanilla-JS single-page
frontend (`index.html`) + Node.js/Express backend, Postgres, Keycloak OIDC auth, pluggable
storage (local / S3 / Supabase). Goal in progress: make it a small business's secure primary
file store (external upload, secure share links, large files). See `RECOMMENDATIONS.md`.

## Deployment
- **Host:** Ubuntu ARM64 box at `192.168.1.32`, root SSH (password auth). Repo at `/opt/memex`.
- **Stack:** `docker compose` — services `app` (:3000), `keycloak` (:8080), `postgres` (:5432).
- **Bring up:** `cd /opt/memex && docker compose up -d` (add `--build app` after code changes).
- **Currently reachable only over plain HTTP at `http://192.168.1.32:3000`** (see HTTPS open loop).

### Credentials / config
- **App login (interim):** `dave@ptechllc.com` / `Memex#2026!` (Keycloak local user, admin role).
- **Keycloak admin:** user `admin`, password in `/opt/memex/.env` (`KEYCLOAK_ADMIN_PASSWORD`).
- **Postgres / app secrets:** all in `/opt/memex/.env` (gitignored). Anthropic key set there.
- `ADMIN_EMAILS=dave@ptechllc.com` → admin role on first login.

## Versioning scheme
`vYYYY.MM.DD.NNN` — calendar date + 3-digit same-day counter (e.g. `v2026.06.04.001`, then
`.002` later that day; resets next day). Source of truth: `VERSION` file at repo root.
Surfaced via `/api/config` and the masthead colophon. Each release gets a git tag.
**To cut a release:** edit `VERSION` → `docker compose up -d --build app` → `git commit` + `git tag -a vYYYY.MM.DD.NNN`.

## Working today (verified)
- Email/password login (Keycloak direct grant; PKCE/SSO can't run on plain-HTTP origin).
- File upload (fixed a latent bug — the data volume was root-owned vs the non-root container user, so uploads previously failed with EACCES).
- Trash: soft-delete → Restore / Delete-forever, with a Files/Trash toggle in the UI.
- Audit logging of download / view / trash / restore / purge to `activity_log`.
- Date-based version scheme in masthead + `/api/config`.
- Rate limiting on `/api/*` via `express-rate-limit` with configurable `.env` knobs; verified `RateLimit` headers on `/api/config`.
- Microsoft 365-inspired theme option added next to Light and Dark in the masthead.
- Files tab rebuilt as a full-screen Microsoft 365-style home with left rail, For you cards, Recent table, Shared view, Trash view, and responsive iPad/iPhone layouts.

## Git state
- **Branch:** `claude/url-request-GwwHe`. **Origin tip is `98ddcfe`** (confirmed via GitHub API).
  The jwks-rsa fix + email/password login (`686dc07`) and `.env` gitignore (`98ddcfe`) are already
  pushed. **10 commits after `98ddcfe` are LOCAL-only on the box** and need pushing after this `.006` cleanup release commit.
  (Note: `git status` may show a larger "ahead" number — the local `origin/...` tracking ref is
  stale because a push was done via explicit URL and a later `git fetch` timed out. Trust `98ddcfe`.)
- Local-only commits: `RECOMMENDATIONS.md`; Caddy TLS overlay; trash/audit/perms;
  `v2026.06.04.001` version scheme; `v2026.06.04.002` Trash UI; handoff update; `v2026.06.08.003` rate limiting; `v2026.06.08.004` Microsoft 365 theme; `v2026.06.08.005` full-screen file home; `v2026.06.08.006` file-home cleanup and 365 default.
- Local-only tags: `v2026.06.04.001`, `v2026.06.04.002`, `v2026.06.08.003`, `v2026.06.08.004`, `v2026.06.08.005`, `v2026.06.08.006`.
- `main` is the **stale Supabase v2** (predates this work); branch is 30 ahead / main 1 ahead — a future merge to main will be a deliberate "replace v2" merge, not fast-forward.

## Key fixes made this session (real bugs)
1. `server/middleware/auth.js` — jwks-rsa v3 API: default export is a factory not a constructor
   (use `{ JwksClient }`); `getSigningKeyAsync` → `getSigningKey`. Was rejecting **every** request.
2. `Dockerfile` — pre-create `/data/documents` owned by `memex` so a fresh named volume is writable.
3. Login over plain HTTP: added an email/password form (direct grant) since `crypto.subtle` (PKCE) is unavailable on insecure origins.

## TO-DO / open loops
1. **Push to GitHub** — needs a fine-grained PAT (Contents: read/write on `cdburgess75/Memex`).
   Push is done inline without persisting the token. Nothing pushed since `98ddcfe`.
2. **HTTPS cutover** (unblocks real SSO + safe external sharing). Caddy config is staged
   (`Caddyfile` + `docker-compose.prod.yml`). Requires, on your side:
   - DNS A record: `files.ptechllc.com → 153.66.221.62` (at directnic). Confirm the public IP is static.
   - Router port-forward: TCP 80 + 443 → `192.168.1.32`.
   - Then: `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`, set
     `APP_URL`/`KEYCLOAK_URL=https://files.ptechllc.com`, `TRUST_PROXY=true`,
     `CORS_ORIGINS=https://files.ptechllc.com`, update Keycloak client redirect URIs, verify SSO.
3. **Next Phase 1 build items** (each its own version bump):
   - `.007` Full-text document search (persist extracted text → Postgres `tsvector` GIN index).
4. **Phase 2+ roadmap** in `RECOMMENDATIONS.md`: secure share links, external/guest upload tokens,
   large-file presigned multipart, folders + ACLs, ClamAV scanning, envelope encryption, backups.

## How to resume
SSH: password auth still works; Codex key generated locally but not yet installed on host. Code edits: edit under `/opt/memex`,
`docker compose up -d --build app`, verify, commit, tag. Get a fresh token via Keycloak direct
grant for API testing (see prior session commands).
