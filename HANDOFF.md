# Memex Complete Handoff

Last updated: 2026-06-15  
Current deployed commit: `998c3f1 Polish file library header`  
Current branch: `claude/url-request-GwwHe`  
Local repo: `/Users/dave/Documents/Memex`  
Live host repo: `/opt/memex`

Important: this document intentionally does not print live passwords, API keys, private keys, service-account JSON, or database passwords. Those values must stay in the operator password manager and in `.env`/host secret stores only. The secret inventory below names every known credential and where it is configured.

## Executive Summary

Memex is a self-hosted file library and knowledge workspace. It is currently a single-page frontend (`index.html`) backed by a Node/Express API (`server/`), Postgres, Keycloak, local document storage, and optional Anthropic/Google/S3 integrations.

The current live deployment is on the Ubuntu host `frog` at `192.168.1.32`.

Current exposed LAN services:

- Memex app: `http://192.168.1.32:3000`
- Keycloak: `http://192.168.1.32:8080`
- SSH: `root@192.168.1.32`
- Postgres: internal Docker network only

Current container status verified 2026-06-15:

- `memex-app-1`: up, published `3000:3000`
- `memex-keycloak-1`: up, published `8080:8080`
- `memex-postgres-1`: up and healthy
- UFW status: inactive

## Security Note

Do not treat the app as a firewall. UFW should be enabled and managed on the Ubuntu host. The app now has a small `Security` indicator and `/api/security/status` endpoint for future host-firewall visibility, but enforcement must stay in UFW, the reverse proxy, SSH hardening, identity controls, patching, backups, and network controls.

## Verified Network / Host Details

Live host:

- Hostname: `frog`
- Current verified LAN IP: `192.168.1.32`
- User previously mentioned `10.0.2.15`; current deploy and checks were performed against `192.168.1.32`.
- SSH user: `root`
- App URL: `http://192.168.1.32:3000`
- Keycloak URL: `http://192.168.1.32:8080`
- Production domain plan: `files.ptechllc.com`

Current listening ports verified:

- `22/tcp`: SSH
- `3000/tcp`: Memex app via Docker proxy
- `8080/tcp`: Keycloak via Docker proxy

Production reverse proxy plan:

- `Caddyfile` routes `files.ptechllc.com`.
- `/realms/*` and `/resources/*` proxy to Keycloak.
- Everything else proxies to app.
- Adds HSTS, `X-Content-Type-Options`, and referrer policy.
- Production overlay: `docker-compose.prod.yml`.

HTTPS prerequisites:

- DNS A record: `files.ptechllc.com -> public IP`
- Router port-forward: TCP `80` and `443` to `192.168.1.32`
- Then run:

```bash
cd /opt/memex
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

After HTTPS is live, update:

- `APP_URL=https://files.ptechllc.com`
- `KEYCLOAK_URL=https://files.ptechllc.com`
- `TRUST_PROXY=true` or a narrower trusted proxy setting
- `CORS_ORIGINS=https://files.ptechllc.com`
- Keycloak client redirect/web origins

## Current Git State

Branch:

```text
claude/url-request-GwwHe
```

Current latest commits:

```text
998c3f1 Polish file library header
6fa38d5 Make file rail library based
f39fa6f Add host security alert indicator
8b2d104 Add folder commander file view
77a9e8b Contain compliance control lists
3e54faa Ignore local secret handoff files
afe2060 Add document access management
458c20b Add document ACL foundation
6cabad8 Fix Keycloak password rotation helper
e782d06 Add interim Keycloak password rotation helper
69e2279 Remove plaintext app credential from handoff
550eaf5 Harden public share link access
f9ea5c5 Bind WOPI tokens to requested files
cf7362c Add compliance readiness admin panel
```

Local status at handoff:

```text
## claude/url-request-GwwHe...origin/claude/url-request-GwwHe
```

No uncommitted changes at the time of this handoff.

## Deployment Commands

Normal deploy from the server:

```bash
cd /opt/memex
git pull --ff-only
docker compose up -d --build app
```

Full stack start:

```bash
cd /opt/memex
docker compose up -d
```

Check services:

```bash
cd /opt/memex
docker compose ps
docker compose logs --tail=100 app
docker compose logs --tail=100 keycloak
docker compose logs --tail=100 postgres
```

Smoke checks:

```bash
curl http://192.168.1.32:3000/api/config
curl http://192.168.1.32:8080/realms/memex/.well-known/openid-configuration
```

## Current Docker Compose

Primary file: `docker-compose.yml`

Services:

- `postgres`
  - Image: `postgres:16-alpine`
  - DBs initialized by `postgres/init`
  - Data volume: `postgres_data`
  - Healthcheck: `pg_isready -U memex -d memex`

- `keycloak`
  - Image: `quay.io/keycloak/keycloak:24.0`
  - Command: `start-dev --import-realm`
  - Realm import: `keycloak/memex-realm.json`
  - Public port: `8080`

- `app`
  - Built from `Dockerfile`
  - Public port: `${PORT:-3000}:3000`
  - Local documents mount: `/srv/memex-documents:/data/documents`

Production overlay: `docker-compose.prod.yml`

- Adds `caddy`
- Publishes `80` and `443`
- Uses `Caddyfile`

## Application Architecture

Frontend:

- `index.html`
- Vanilla JS single-page app
- Theme switcher
- File-first workspace
- Library rail and commander/list file views
- Admin/compliance panel
- Security indicator

Backend:

- `server/index.js`
- Express API
- JWT auth through Keycloak JWKS
- Postgres via `pg`
- Optional Anthropic, Google Drive, Supabase, S3 integrations

Core libraries:

- `server/lib/db.js`
- `server/lib/settings.js`
- `server/lib/storage.js`
- `server/lib/documentAccess.js`
- `server/lib/encryption.js`
- `server/lib/wopiTokens.js`
- `server/lib/rateLimiters.js`
- `server/lib/compliance.js`

Database/schema:

- `postgres/init/01_schema.sql`
- Supabase-era migrations retained under `supabase/migrations`

Auth:

- Keycloak realm: `memex`
- Keycloak client: `memex-app`
- Roles used in app: `admin`, `contributor`, `viewer`

## API Route Map

Public/config:

- `GET /api/config`
- `GET *` serves `index.html`
- Static assets from repo root

Auth:

- `GET /api/auth/me`

Pages:

- `GET /api/pages`
- `GET /api/pages/search?q=...`
- `GET /api/pages/:id/versions`
- `POST /api/pages/:id/restore/:versionId`
- `PUT /api/pages/:id`
- `DELETE /api/pages/:id`
- `DELETE /api/pages`

AI:

- `POST /api/ai/ingest`
- `POST /api/ai/query`
- `POST /api/ai/lint`
- `POST /api/ai/extract`

Log:

- `GET /api/log`

Security status:

- `GET /api/security/status`

Admin:

- `GET /api/admin/stats`
- `GET /api/admin/users`
- `PUT /api/admin/users/:userId/role`
- `GET /api/admin/usage`
- `GET /api/admin/compliance`
- `PUT /api/admin/compliance`
- `GET /api/admin/settings`
- `PUT /api/admin/settings`

Files:

- `GET /api/files`
- `GET /api/files/trash`
- `GET /api/files/search?q=...`
- `POST /api/files/upload`
- `POST /api/files/upload-stream`
- `POST /api/files/uploads`
- `GET /api/files/uploads/:sessionId`
- `PUT /api/files/uploads/:sessionId/chunks/:index`
- `POST /api/files/uploads/:sessionId/complete`
- `DELETE /api/files/uploads/:sessionId`
- `GET /api/files/local-download`
- `GET /api/files/share/:token`
- `GET /api/files/:id/shares`
- `POST /api/files/:id/shares`
- `DELETE /api/files/:id/shares/:shareId`
- `GET /api/files/shares`
- `GET /api/files/:id/access`
- `PUT /api/files/:id/access`
- `DELETE /api/files/:id/access/:grantId`
- `POST /api/files/:id/ingest`
- `GET /api/files/:id/url`
- `GET /api/files/:id/office`
- `POST /api/files/:id/google`
- `POST /api/files/:id/google/export`
- `GET /api/files/:id/history`
- `POST /api/files/:id/restore-version/:versionId`
- `DELETE /api/files/:id`
- `POST /api/files/:id/restore`
- `DELETE /api/files/:id/purge`
- `POST /api/files/ask`

WOPI:

- `GET /wopi/files/:fileId`
- `GET /wopi/files/:fileId/contents`
- `POST /wopi/files/:fileId/contents`
- `POST /wopi/files/:fileId`

## Rate Limiting

Configured in `server/lib/rateLimiters.js`.

Defaults:

- General API: 300 requests / 15 minutes
- Auth: 20 requests / 15 minutes
- Share links: 60 requests / 15 minutes

Env knobs:

- `RATE_LIMIT_ENABLED`
- `RATE_LIMIT_WINDOW_MS`
- `RATE_LIMIT_API_MAX`
- `RATE_LIMIT_AUTH_MAX`
- `RATE_LIMIT_SHARE_WINDOW_MS`
- `RATE_LIMIT_SHARE_MAX`

## Secret Inventory

Live secret values are not printed here.

Configured in `.env`, Docker environment, DB-backed settings, or operator password manager:

- `DATABASE_URL`
- `KEYCLOAK_URL`
- `KEYCLOAK_INTERNAL_URL`
- `KEYCLOAK_REALM`
- `KEYCLOAK_CLIENT_ID`
- `KEYCLOAK_ADMIN_USER`
- `KEYCLOAK_ADMIN_PASSWORD`
- `POSTGRES_PASSWORD`
- `ANTHROPIC_API_KEY`
- `ANTHROPIC_MODEL`
- `ADMIN_EMAILS`
- `PORT`
- `APP_URL`
- `STORAGE_PROVIDER`
- `STORAGE_LOCAL_PATH`
- `KEYCLOAK_PUBLIC_PORT`
- `GOOGLE_SERVICE_ACCOUNT_KEY`
- `GOOGLE_DRIVE_FOLDER_ID`
- `STORAGE_S3_BUCKET`
- `STORAGE_S3_REGION`
- `STORAGE_S3_ACCESS_KEY_ID`
- `STORAGE_S3_SECRET_ACCESS_KEY`
- `STORAGE_S3_ENDPOINT`
- `STORAGE_S3_FORCE_PATH_STYLE`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `STORAGE_ENCRYPTION_KEY`
- `BIND_ADDRESS`
- `TRUST_PROXY`
- `CORS_ORIGINS`
- `HTTP_PROXY`
- `MAX_UPLOAD_MB`
- `TRASH_RETENTION_DAYS`
- `COMPLIANCE_SOC2_ENABLED`
- `COMPLIANCE_HIPAA_ENABLED`
- `COMPLIANCE_GDPR_ENABLED`
- `COMPLIANCE_PCI_DSS_ENABLED`
- `COMPLIANCE_ISO27001_ENABLED`
- `COMPLIANCE_CMMC_ENABLED`
- `SECURITY_STATUS_FILE`
- `SECURITY_ALERT_LEVEL`
- `SECURITY_RECENT_CONNECTIONS`
- `SECURITY_MONITOR_CONFIGURED`
- `SECURITY_FIREWALL`
- `SECURITY_ALERT_WINDOW`
- `SECURITY_ALERT_MESSAGE`

Known operational credentials and handling:

- Root SSH credential for `root@192.168.1.32`
  - Supplied out-of-band during development.
  - Do not commit or paste into docs.
  - Rotate before production.

- Keycloak admin credential
  - User is controlled by `KEYCLOAK_ADMIN_USER`.
  - Password is `KEYCLOAK_ADMIN_PASSWORD` in `/opt/memex/.env`.
  - Do not print or commit.

- App user credential for `dave@ptechllc.com`
  - A development password was set per operator instruction.
  - Do not rotate during active development unless explicitly instructed.
  - Do not print in docs or commit history.
  - Store in the password manager.

- Postgres credential
  - Controlled by `POSTGRES_PASSWORD`.
  - Used by Postgres, Keycloak DB, and app `DATABASE_URL`.
  - Rotation requires coordinated container/app updates.

- Anthropic API key
  - `ANTHROPIC_API_KEY`.
  - Server-only.
  - Never sent to browser.

- Google service account JSON
  - `GOOGLE_SERVICE_ACCOUNT_KEY`.
  - Optional.
  - High sensitivity; rotate if ever pasted in chat or logs.

- S3-compatible storage keys
  - `STORAGE_S3_ACCESS_KEY_ID`
  - `STORAGE_S3_SECRET_ACCESS_KEY`
  - Optional.

- Storage encryption key
  - `STORAGE_ENCRYPTION_KEY`.
  - If lost, encrypted local files are unrecoverable.
  - If changed incorrectly, old encrypted files become unreadable.

## Current Product State

Working and recently implemented:

- Keycloak-backed login.
- Admin/contributor/viewer roles.
- File upload, drag/drop, folder upload path preservation.
- Large streaming uploads.
- Resumable chunked uploads for local-backed storage.
- Local document storage under `/srv/memex-documents`.
- File list and commander modes.
- Folder grouping based on uploaded relative paths.
- Library-style rail with collapsible library section.
- Professionalized library header and compact Upload/Search rail actions.
- Shared files, links, trash, restore, purge.
- Public share links with token hash, expiration, optional password, revoke, access counts.
- Document ACL foundation and access management.
- File details pane.
- Ask selected documents.
- AI ingest/query/lint/extract.
- Page version history and restore.
- File version history and restore.
- WOPI token binding to requested files.
- Google Drive edit/export hooks.
- Admin usage/cost dashboard.
- Compliance profile toggles and readiness control summaries.
- Security indicator plus read-only `/api/security/status`.
- Rate limiting.
- Local backup and non-destructive verify scripts.
- Caddy production reverse proxy plan.

## Recent UI Direction

The current design direction is a file-first product:

- Users are in libraries, similar to rooms or SharePoint sites.
- The left rail should not feel like a personal profile area.
- The rail library name should be the primary context.
- Items beneath the library should collapse.
- `Home` and `Files` were merged conceptually.
- Commander/list view is optional via toggle.
- True libraries/rooms/sites are still future work; currently the UI uses a temporary library name derived from the user.

## Compliance / Update Work

Documents:

- `COMPLIANCE_ROADMAP.md`
- `docs/UPDATE_AND_COMPLIANCE_DESIGN.md`

Compliance profiles in UI:

- SOC 2
- HIPAA
- GDPR
- PCI-DSS
- ISO/IEC 27001
- CMMC

Important semantics:

- Toggles track readiness profiles.
- They do not certify the organization.
- They do not make the product compliant by themselves.
- They should feed future evidence exports.

Update architecture target:

```text
Admin UI -> /api/admin/update-jobs -> queue row -> host runner -> allowlisted root-owned script -> evidence log
```

Do not let the app container run arbitrary host commands as root.

## UFW / Security Monitor Plan

Current state:

- UFW is installed or available but currently inactive on `frog`.
- App has `Security` indicator.
- Backend has `GET /api/security/status`.
- Route is authenticated.
- It can read `SECURITY_STATUS_FILE` JSON in the future.

Recommended next steps:

1. Enable UFW with explicit allow rules:

```bash
ufw allow 22/tcp
ufw allow 3000/tcp
ufw allow 8080/tcp
# After HTTPS cutover:
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
ufw status verbose
```

2. After HTTPS/reverse proxy is live, strongly consider limiting direct `3000` and `8080` exposure to LAN/admin only.

3. Add root-owned host script that summarizes:

- Recent rejected connections
- Top source IPs
- SSH auth failures
- UFW deny counts
- Time window
- Severity level

4. Write JSON to a mounted file, for example:

```json
{
  "level": "ok",
  "configured": true,
  "firewall": "UFW",
  "recentConnections": 0,
  "window": "15 minutes",
  "message": "No unusual connection pressure reported.",
  "updatedAt": "2026-06-15T21:00:00Z"
}
```

5. Point app env at it:

```env
SECURITY_STATUS_FILE=/data/security/status.json
```

## Backup / Restore

Backup script:

```bash
scripts/backup-memex.sh
```

Defaults:

- `MEMEX_ROOT=/opt/memex`
- `MEMEX_DOCS_DIR=/srv/memex-documents`
- `MEMEX_BACKUP_DIR=/srv/memex-backups`

Backup output:

- `postgres-memex.dump`
- `documents.tar.gz`
- `manifest.txt`
- `SHA256SUMS`

Verify script:

```bash
scripts/verify-backup.sh /srv/memex-backups/<backup-id>
```

Important:

- Current backup is local staging only.
- Configure off-host backups before production use.
- Schedule restore tests and save evidence.

## Testing

Node tests:

```bash
cd server
npm test
```

Targeted tests that have been useful:

```bash
cd server
npm test -- --runInBand __tests__/routes/admin.compliance.test.js
npm test -- --runInBand __tests__/routes/files.access.test.js
npm test -- --runInBand __tests__/routes/wopi.test.js
npm test -- --runInBand __tests__/lib/documentAccess.test.js
```

Frontend syntax check for embedded JS:

```bash
node -e "const fs=require('fs');const html=fs.readFileSync('index.html','utf8');const js=html.match(/<script>([\s\S]*)<\/script>/)[1];new Function(js);console.log('embedded script ok')"
```

Whitespace check:

```bash
git diff --check
```

## Operational Commands

Local development:

```bash
cd /Users/dave/Documents/Memex
node server/index.js
```

Install/update server dependencies:

```bash
cd server
npm install
```

Run local tests:

```bash
cd server
npm test
```

Deploy live app:

```bash
ssh root@192.168.1.32
cd /opt/memex
git pull --ff-only
docker compose up -d --build app
```

Check live app:

```bash
curl http://192.168.1.32:3000/api/config
```

Check live Docker services:

```bash
cd /opt/memex
docker compose ps
```

Check UFW:

```bash
ufw status verbose
```

## Known Gaps / Backlog

Security and production readiness:

- Enable HTTPS for `files.ptechllc.com`.
- Move to real SSO/MFA and disable interim direct-password development flow.
- Enable/configure UFW.
- Add host-side UFW/security monitor feeding `/api/security/status`.
- Harden SSH.
- Tighten CORS and reverse proxy trust after domain cutover.
- Add malware scanning for uploads.
- Add immutable or append-only audit log.
- Add access review export.
- Configure off-host backups and scheduled restore tests.
- Add vulnerability/dependency scanning evidence.

Product:

- Real libraries/rooms/sites data model.
- True server-side folder metadata and APIs.
- Create/rename/move folders.
- Drag files between folders.
- Folder-level permissions and inheritance.
- Group notifications for file changes.
- Notification center beside Security indicator.
- File classification labels.
- Retention policies.
- Legal hold.
- DLP/sensitive-pattern detection.
- AI governance controls and no-AI zones.
- Evidence export package.

Storage:

- Production-grade dedicated storage, NAS, ZFS dataset, or object storage.
- Off-box backups.
- S3 multipart support for object storage.
- Encryption key custody and rotation policy.

Compliance:

- SOC 2-style control matrix.
- HIPAA/CMMC readiness only after policies, access review, audit export, retention, and legal hold are ready.
- ISO 27001 requires organization-wide ISMS work, not just product features.

## Do Not Do

- Do not commit `.env`.
- Do not paste passwords/API keys into docs, chats, issue trackers, screenshots, or commits.
- Do not run destructive git commands such as `git reset --hard` unless explicitly requested.
- Do not rotate the development app password during active development unless Dave explicitly asks.
- Do not claim compliance certification from the UI toggles.
- Do not make the app container a root host-command executor.
- Do not treat the Security indicator as firewall enforcement.

## Immediate Next Good Steps

1. Hard refresh browser and inspect latest file library UI.
2. Enable UFW safely with SSH preserved.
3. Add host-side security status writer for UFW/SSH connection pressure.
4. Start the real libraries/rooms/sites model.
5. Add grouped file-change notifications.
6. Plan HTTPS cutover for `files.ptechllc.com`.
7. Configure off-host backups.
8. Decide storage target for production.
