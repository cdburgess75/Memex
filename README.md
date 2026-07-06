# Memex

A self-hosted team file and knowledge hub with single sign-on, in-browser Office editing, multi-provider AI, document libraries, notifications, audit history, and a live compliance dashboard. Your data, your server, your choice of AI.

Most knowledge tools are retrieval-only — you put documents in and search them back out, and nothing accumulates. Memex is different: it **builds and maintains a persistent, interlinked knowledge base** while doubling as a real document library. Upload a Word doc, drop a PDF, paste an article, or point it at a URL — files are stored, indexed, and made answerable; sources are summarized into cross-linked pages. Ask a question in plain English and get an answer grounded in the files and pages your team actually owns.

Everything runs on infrastructure you control: a self-hosted **Postgres** database, **Keycloak** for authentication, local or S3-compatible file storage, and the AI provider of your choice — Anthropic's Claude, any OpenAI-compatible API, or a self-hosted model. No proprietary platform, no vendor lock-in.

---

## Highlights

- **Self-hosted stack** — Postgres + Keycloak + a Node/Express app (+ optional Collabora editor), all via one `docker compose up`.
- **Single sign-on** — Keycloak OIDC with optional Google / Microsoft 365 identity brokering.
- **Edit Word & Excel in the browser** — self-hosted **Collabora** (WOPI) served same-origin through the app: no Microsoft account, no extra ports, edits saved back with version history.
- **Multi-provider AI** — Claude *and* any number of OpenAI-compatible endpoints (OpenAI, Groq, Together, OpenRouter, or self-hosted Ollama / vLLM / LM Studio). Pick the active model from the search-bar control, or turn AI off entirely.
- **Answers grounded in your files** — ask a question and Claude (or your chosen model) answers from the text of your uploaded documents *and* ingested pages, citing what it used — scoped to the libraries you choose.
- **Unified search** — one box with an **Auto** mode that routes a natural-language question to the AI and keyword/filename queries to full-text search.
- **Document libraries** — organize files into separate libraries with per-library membership; browse as a flat list or a folder-tree **Commander** view.
- **Share links & file requests** — send expiring / password-protected download links, or a public **upload link** so a non-member can send files *to* you without an account.
- **In-app notifications** — a header bell with unread badge: file shared with you, your share link downloaded, your document edited, upload received. Optional email (SMTP) per upload link.
- **Team calls** — built-in WebRTC video/audio calls with presence (STUN/TURN configurable).
- **Live compliance dashboard** — readiness profiles for SOC 2, HIPAA, GDPR, PCI-DSS, ISO 27001, and CMMC, scored from *real* signals, with manual attestation and a printable evidence export.
- **Update awareness** — a status pill in the header rolls up security, compliance, and whether you're behind the latest published release.
- **Everything configurable in-app** — storage, encryption, email, integrations, AI providers, and compliance are managed from an admin Settings panel; environment variables are just the initial defaults.

---

## Features

### Knowledge & AI

| Operation | What it does |
|-----------|-------------|
| **Ask** | Ask anything in plain English. The model answers from your uploaded files and ingested pages, names what it drew on, and can file the answer back as its own page. Streams in real time with a Stop button. |
| **Ingest** | Paste text, enter a URL, or upload a file. The model reads the source, writes a summary, and creates or updates interlinked pages. |
| **Audit (Lint)** | Health-check the collection — contradictions, orphaned pages, missing cross-references, and gaps worth chasing. |

- **Multi-provider, switchable models** — configure Anthropic plus one or more OpenAI-compatible endpoints (each with its own base URL, key, and model list). The active model is chosen from the ✦ picker in the top bar; "AI off" disables AI features and reshapes the search bar.
- **Self-hosted models** — point an OpenAI-compatible endpoint at Ollama / vLLM / LM Studio (e.g. `http://host:11434/v1`) — no key required.
- **Per-file grounding** — the AI only sees files the asking user is allowed to read.

### Document library

- **Upload anything** — any file type, folder uploads with structure preserved, resumable chunked uploads for large files (size limit configurable).
- **Multiple libraries** — group files into libraries; restrict a library to specific members, or leave it open to the team.
- **In-browser preview** — PDF, images, and text render inline; Excel and Word are rendered client-side (SheetJS / mammoth) with no external service.
- **In-browser editing (Collabora/WOPI)** — an optional `collabora/code` container gives full Word/Excel/PowerPoint editing, reverse-proxied through the app's own origin (works on plain-HTTP dev boxes and behind HTTPS in production). Every save snapshots a version and re-indexes the text for search.
- **Open in desktop app / Google Drive** — hand a file to local Office or to Docs/Sheets/Slides and export edits back to storage.
- **Share links** — expiring, optionally password-protected public download links; owners are notified when a link is used.
- **File requests (upload links)** — generate a public `/u/…` page where a non-member can drop files or whole folders into a library/folder you choose; per-link in-app and email notification toggles.
- **Versioning & trash** — every save snapshots a version; deleted files sit in trash with a configurable retention window before purge.
- **Per-file access control** — owner/admin grants via a document ACL; admins see everything, owners see their own, others see what's shared with them.
- **Full-text search** — Postgres `tsvector` over document text and names, with highlighted excerpts.
- **List & Commander views** — flat table or two-pane folder tree with collapsible branches (remembered per device).

### Search, notifications & profiles

- **Unified search box** — `Auto` (default) detects whether you're searching or asking; explicit **Contents**, **File names**, and **Ask AI** scopes plus the active AI model live in one combined control.
- **Notifications** — header bell + dropdown (mark-read, click-through to the file) with a per-user opt-out in **Settings → Notifications**; events cover shares, share-link downloads, document edits, and inbound uploads. Email delivery is available via SMTP (Settings → System → Email).
- **User profiles** — display name and avatar; any photo is auto-resized client-side, and the identity provider's picture (Google/365) is used as a default until you set your own.
- **Appearance** — light/dark and themed variants, plus a pickable accent color, saved per device.

### Compliance & security

- **Readiness profiles** — SOC 2, HIPAA, GDPR, PCI-DSS, ISO 27001, CMMC, each toggleable.
- **Live signals** — control status is computed from the actual system: is an encryption key set, is the audit log active, is retention configured, is an AI provider configured, is `app_url` HTTPS, are backup scripts present, is the app under version control.
- **Runtime probes** (on demand) — real HTTPS reachability/cert check, `npm audit` dependency advisories, and backup freshness.
- **Manual attestation** — controls that can't be auto-detected (incident response, risk register, vuln management, data-subject workflow) are marked met with who/when/note.
- **Evidence export** — download a printable HTML report of every control's status, evidence, and attestations for an assessor.
- **At-a-glance pill** — a header chip shows overall posture (ready/total, color-coded).
- **Host firewall status** — a security indicator surfaces UFW/connection monitoring when wired up.

### Admin

- **Settings hub** — Profile · Appearance · Notifications · AI providers · System (storage, at-rest encryption, email/SMTP, integrations, network, scheduled backups) — all backed by a DB-stored settings table; secrets are masked.
- **Usage & cost** — token consumption and estimated spend per user, per operation.
- **Team management** — list users, assign Admin / Contributor / Viewer roles.
- **Activity log** — every ingest, query, audit, upload, edit, and share is attributed.
- **Scheduled backups** — database + documents to one or more destinations on a schedule, with retention pruning; compliance probes check freshness.
- **Update check** — the header status pill compares the running `VERSION` against published GitHub releases (green / behind / unavailable) and links to `upgrade.sh`.
- **Settings backup** — export system settings to XML (secrets masked).

---

## Architecture

```
Browser (index.html — single-file SPA)          Non-members (no account)
    │  Keycloak OIDC (PKCE) for login               │  /u/<token> upload page
    │  Fetch API + WebSocket (/ws calls,            │  /api/files/share/<token>
    │  /cool editor socket)                         │  downloads
    ▼                                               ▼
Node.js / Express  (server/)
    ├─ auth middleware     — verifies the Keycloak JWT (JWKS) on every request
    ├─ /api/config         — public Keycloak settings for the browser PKCE flow
    ├─ /api/auth           — identity (/me) + editable profile (name, avatar)
    ├─ /api/pages          — CRUD, full-text search, version history
    ├─ /api/ai             — provider abstraction (ingest · query · lint · extract)
    ├─ /api/files          — upload, search, share links, upload links, ACL, trash
    ├─ /api/notifications  — in-app notification feed + prefs (+ SMTP test)
    ├─ /api/libraries      — libraries + membership
    ├─ /api/admin          — stats, users, usage, compliance (+ runtime probes)
    ├─ /api/admin/settings — DB-backed system settings (storage, AI, email…)
    ├─ /api/security       — host firewall status
    ├─ /api/version        — update check against GitHub release tags
    ├─ /api/backup         — scheduled backup config + download
    ├─ /wopi               — WOPI host (CheckFileInfo / GetFile / PutFile / locks)
    ├─ /browser /cool /hosting — same-origin reverse proxy → Collabora editor
    └─ /ws                 — WebRTC signaling (presence + call brokering)
    │
    ├─ Postgres 16        pages, documents, document_acl, document_share_links,
    │                     upload_links, notifications, libraries, library_members,
    │                     user_roles, user_profiles, page_versions, api_usage,
    │                     activity_log, system_settings, compliance_attestations
    │
    ├─ Keycloak           realm "memex", client "memex-app" (+ optional
    │                     Google / Microsoft identity brokering)
    │
    ├─ Collabora CODE     optional in-browser Office editing (WOPI), reached
    │                     only through the app's same-origin proxy
    │
    ├─ File storage       local filesystem (default, optional AES-256-GCM)
    │                     · S3-compatible (AWS / R2 / B2 / MinIO / Spaces)
    │                     · Supabase Storage (legacy)
    │
    ├─ Email              SMTP (nodemailer) for notification mail — optional;
    │                     in-app notifications work without it
    │
    └─ AI providers       Anthropic (Claude) + any OpenAI-compatible endpoints
```

API keys and secrets live only on the server (or in the DB settings, masked in the UI) — never sent to the browser.

---

## One-command install (recommended)

On a fresh Linux box with Docker installed, this clones the repo, generates
strong secrets, asks a few questions (mode, admin email, Anthropic key), writes
`.env`, and brings the whole stack up:

```bash
curl -fsSL https://raw.githubusercontent.com/cdburgess75/Memex/main/install.sh | bash
```

Or, from a clone, just run `./install.sh`. Pick **local** mode for a LAN/dev box
(`http://localhost:3000`) or **public** mode to serve an HTTPS domain via the
built-in Caddy reverse proxy. The installer never reuses the placeholder
`changeme` secrets — each deployment gets its own randomly generated Postgres /
Keycloak / encryption credentials. Re-running it detects an existing `.env` and
offers to keep your current secrets.

## Quick start (manual Docker Compose)

Prefer to wire it up by hand? The repo ships a `docker-compose.yml` that brings up **Postgres**, **Keycloak**, and the **app** together.

```bash
cp .env.example .env        # then edit the values (see below)
docker compose up -d --build
```

This starts:

- **postgres** — the database (schema is applied automatically from `postgres/init/`, and the app runs idempotent migrations on boot).
- **keycloak** — auth at `:8080`.
- **app** — Memex at `:3000`.

Open `http://localhost:3000` and sign in.

### Sign in (zero manual Keycloak setup)

Keycloak auto-imports the **`memex`** realm and public **`memex-app`** client (PKCE,
redirect URIs, email/name mappers) from `keycloak/memex-realm.json` on first boot —
no admin-console steps required. The realm also seeds a **bootstrap admin**:

- **Email:** `admin@memex.local` **Password:** `memex-admin` (you're forced to change it on first login)
- It's listed in `ADMIN_EMAILS`, so it gets the **admin** role immediately.

For a real deployment: log in as the bootstrap admin, then add your team and/or
connect SSO, and set `ADMIN_EMAILS` to your own admin address(es).

*(Optional SSO)* In the Keycloak admin console (`/admin/`, `KEYCLOAK_ADMIN_USER` /
`KEYCLOAK_ADMIN_PASSWORD`) add **Google** / **Microsoft** identity providers. To carry
their profile picture into Memex, add an attribute-importer mapper for the `picture`
claim plus a client mapper that adds `picture` to the access token.

### Environment variables

All values live in `.env` (copied from `.env.example`). The essentials:

```env
# Database
DATABASE_URL=postgres://memex:changeme@postgres:5432/memex
POSTGRES_PASSWORD=changeme

# Auth — Keycloak  (KEYCLOAK_URL=auto derives the browser URL from the request host)
KEYCLOAK_URL=auto
KEYCLOAK_INTERNAL_URL=http://keycloak:8080
KEYCLOAK_REALM=memex
KEYCLOAK_CLIENT_ID=memex-app
KEYCLOAK_ADMIN_USER=admin
KEYCLOAK_ADMIN_PASSWORD=changeme

# AI — Anthropic (more providers added in-app under Settings → AI)
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-6

# Admins (comma-separated) — these emails get the admin role on first login
ADMIN_EMAILS=you@yourcompany.com

# Server / app
PORT=3000
APP_URL=https://your-app-url.com        # public URL (share links fall back to the request host)

# In-browser Office editing (optional — see "In-browser Office editing" below)
COLLABORA_ENABLED=true
# COLLABORA_SSL_TERMINATION=true        # set true when Memex is served over HTTPS

# File storage — local (default), s3, or supabase
STORAGE_PROVIDER=local
STORAGE_LOCAL_PATH=/data/memex/documents
# At-rest AES-256-GCM for local storage (also settable in-app; losing it loses the files)
# STORAGE_ENCRYPTION_KEY=
```

See [.env.example](.env.example) for the full list, including S3 storage, Google Drive, network/proxy, and rate-limiting options. **Most of these are also editable at runtime** in **Settings → System** (stored in the DB; env vars are the fallback/initial defaults).

---

## In-browser Office editing (Collabora)

Editing is optional and off by default — without it, Office files still preview
read-only in the browser. To turn it on:

```bash
docker compose up -d collabora        # pulls collabora/code (~1 GB) and starts it
echo "COLLABORA_ENABLED=true" >> .env
docker compose up -d app              # restart the app to pick it up
```

The **Edit** button then appears on Word/Excel/PowerPoint files (and in the
preview and right-click menus). The editor is **reverse-proxied through the
app's own origin** — the browser never talks to Collabora's port directly, so
there's nothing extra to expose, forward, or put behind TLS. Saves flow back via
WOPI with a version snapshot and text re-index on every save.

Deployment notes:

- **HTTPS deployments:** set `COLLABORA_SSL_TERMINATION=true` so the editor uses
  `wss://`; leave it unset/false for plain-HTTP dev boxes.
- **Collabora's admin console is never proxied** — the app blocks `/browser/…/admin`
  and `/cool/adminws` from the public origin. Still, set
  `COLLABORA_ADMIN_PASSWORD` in `.env` (defaults are guessable).
- Editing degrades gracefully: if the Collabora container is stopped or
  unreachable, files fall back to read-only preview.

---

## Running locally (without Docker)

You'll need Node 20+, a Postgres database, and a reachable Keycloak.

```bash
cd server
npm install
npm run dev        # node --watch index.js  (or: npm start)
```

Point `DATABASE_URL` at your Postgres and the `KEYCLOAK_*` vars at your Keycloak, then open `http://localhost:3000`.

### Tests

```bash
cd server && npm test      # jest
```

---

## Prebuilt images & updating

Every push to `main` publishes the app image to GHCR as
`ghcr.io/cdburgess75/memex:latest`, and each pushed `vX.Y.Z` git tag publishes a
pinned `:vX.Y.Z` release. `install.sh` pulls `:latest` by default (no local
build), and you can upgrade in place without source:

```bash
./upgrade.sh                  # pull and deploy :latest
./upgrade.sh v2026.06.22.001  # pin to a specific release
```

`upgrade.sh` records the chosen tag as `MEMEX_TAG` in `.env`, pulls just the app
image, recreates the container, and health-checks `:3000`.

**Cutting a release** (maintainers): `./release.sh` bumps `VERSION` to the next
`vYYYY.MM.DD.NNN`, commits, tags, and pushes — which triggers the multi-arch
build. Use `./release.sh -n` to preview or `./release.sh vX.Y.Z` to set an
explicit version.

> The GHCR package must be **public** for unauthenticated customer pulls. If it
> isn't, `install.sh` automatically falls back to building from source.

## Deployment

Memex is a small stack (Postgres + Keycloak + a stateless Node container). The reference deployment is **Docker Compose on a single host**:

```bash
git pull
docker compose up -d --build app      # rebuild just the app after a code change (source)
```

Put a TLS-terminating reverse proxy (Caddy, nginx, Traefik) in front, set `APP_URL` to the HTTPS URL, and set `TRUST_PROXY` appropriately. The same compose stack runs on any Docker host — a VPS, a home server, Portainer, Unraid, or TrueNAS SCALE.

For a managed single-container app (Railway, Fly.io, Cloud Run, Azure Container Apps, etc.) you can run the app image against an external managed Postgres and a hosted Keycloak — supply the same environment variables.

---

## Storage providers

| Provider | When to use | Config |
|----------|-------------|--------|
| **Local** (default) | Single host; simplest. Optional AES-256-GCM at-rest encryption. | `STORAGE_LOCAL_PATH` (+ optional `STORAGE_ENCRYPTION_KEY`) |
| **S3-compatible** | AWS S3, Cloudflare R2, Backblaze B2, MinIO, DigitalOcean Spaces. | `STORAGE_S3_*` (bucket, region, keys, endpoint, path-style) |
| **Supabase Storage** | Legacy / Supabase-hosted deployments. | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |

The provider can be changed at runtime in **Settings → System → File Storage** (changing it does not migrate existing files).

---

## Open source credits

See [GUMBO.md](GUMBO.md) for the open source libraries and fonts that make this possible.

---

## Origin

The name and concept come from Vannevar Bush's 1945 essay *As We May Think*, in which he described the Memex — a private, associative knowledge store with trails between documents. Bush couldn't solve who does the maintenance. An LLM can.

---

## License

MIT — see [LICENSE](LICENSE).
