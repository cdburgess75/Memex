# Memex

**A self-hosted team file and knowledge hub with in-browser Office editing, AI search grounded in your own documents, and audit-ready compliance controls. Your files, notes, and answers stay on infrastructure you own.**

![version](https://img.shields.io/badge/version-v2026.07.11-blue)
![tests](https://img.shields.io/badge/tests-198%20passing-brightgreen)
![stack](https://img.shields.io/badge/stack-Node%20%C2%B7%20Postgres%20%C2%B7%20Keycloak-informational)
![deploy](https://img.shields.io/badge/deploy-Docker%20Compose-2496ED)
![license](https://img.shields.io/badge/license-see%20below-lightgrey)

> Replace the badges above with live ones once CI, coverage, and a license are wired up (GitHub Actions, Codecov, SPDX).

---

## Overview: the why

Most teams end up with files scattered across a consumer cloud drive, notes in a separate wiki, and no real answer to "who can see this?" or "prove what happened to that document." Memex collapses that into one private, self-hosted workspace:

- **One place for files and knowledge.** Upload documents into permissioned libraries, and keep living notes as knowledge pages next to them. It is a working hub, not a wiki.
- **AI that only knows what you give it.** Ask questions and get answers grounded in your own indexed files and pages, with the AI provider and model configurable (Anthropic by default, OpenAI-compatible endpoints, or a self-hosted Ollama).
- **Edit in the browser, keep the data.** Word, Excel, and PowerPoint files open in a self-hosted Collabora editor over WOPI. No Microsoft or Google account, and the bytes never leave your server.
- **Built for review and audit.** Every file event is written to a tamper-evident, hash-chained activity log. Admins get a one-click access review, a compliance readiness view across six frameworks, and evidence exports.

It stands out because it is genuinely self-contained: a Docker Compose stack you run on your own box, with authentication, encryption at rest, backups, and compliance tooling included rather than bolted on. An MSP can replicate it per customer; a single team can run one instance for themselves.

**Who this is for:** IT admins and technical teams evaluating a private alternative to hosted file and knowledge tools, MSPs deploying a repeatable per-customer workspace, and developers who want to self-host or extend the platform.

---

## Key features

| Area | What you get |
|---|---|
| **Documents** | Permissioned libraries, folder trees, drag-and-drop upload, folder upload, versions, trash / restore / purge, per-document history. |
| **In-browser Office editing** | Word / Excel / PowerPoint editing via self-hosted Collabora (WOPI), proxied same-origin. Read-only preview when editing is off. |
| **Knowledge and AI** | Markdown knowledge pages, plus AI Q&A grounded in your indexed files and pages. Configurable provider and model. |
| **Search** | Scoped search (auto, file contents, file names, or Ask AI) with an inline model picker. |
| **Sharing and access** | Public share links (expiry, optional password), granular per-document ACLs (read / write / admin), and library membership. |
| **File requests** | Inbound upload links: collect files from people with no account, straight into a chosen library and folder. |
| **Notifications** | In-app bell plus email. Email via Microsoft Graph (app-only sendMail) or SMTP, with per-event admin toggles. |
| **Calls** | Member-to-member video and audio (WebRTC) with configurable STUN / TURN and an optional ScreenConnect link. |
| **Branding** | Admin-set workspace name, logo, and default accent, applied everywhere including the sign-in screen. |
| **Audit and compliance** | Tamper-evident (hash-chained) activity log with integrity verify, access-review CSV export, and a readiness view across SOC 2, HIPAA, GDPR, PCI-DSS, ISO 27001, and CMMC with live probes and admin attestations. |
| **Security** | Keycloak OIDC (PKCE), role-based access (admin / contributor / viewer), rate limiting, baseline security headers, AES-256-GCM encryption at rest, configurable CORS and reverse-proxy trust. |
| **Operations** | One-command installer, prebuilt multi-arch images, scheduled backups with off-box destinations, settings export, and an auto update check. |
| **Migration** | Import an existing Seafile library (with folder structure preserved) directly from the admin UI. |

---

## Architecture

Memex is a small, legible stack. There is no build step for the frontend: it is a single self-contained HTML file served by the API.

```
Browser (single-file SPA, index.html)
        |
        v
Node / Express API  ----> PostgreSQL        (data, ACLs, audit chain)
        |            \--> Keycloak (OIDC)    (authentication + roles)
        |            \--> Collabora (WOPI)   (in-browser Office editing, optional)
        |            \--> Object / local FS  (encrypted document storage)
        v
Caddy reverse proxy (optional, production TLS)
```

| Layer | Technology |
|---|---|
| Frontend | Single-file vanilla-JS SPA (`index.html`), no bundler |
| API | Node.js + Express |
| Database | PostgreSQL 16 |
| Auth | Keycloak 24, OIDC with PKCE, roles: admin / contributor / viewer |
| Office editing | Collabora CODE over WOPI (optional) |
| Storage | Local filesystem (AES-256-GCM at rest), S3-compatible, or Supabase |
| AI | Anthropic (default), OpenAI-compatible, or self-hosted Ollama |
| Packaging | Docker Compose, prebuilt images on GHCR |
| TLS (production) | Caddy with on-demand Let's Encrypt |

### Project layout

```
Memex/
├── index.html                 # The entire SPA (UI + client logic), single file
├── server/
│   ├── index.js               # Express app: middleware, routes, startup, WS upgrade
│   ├── routes/                # HTTP surface
│   │   ├── auth.js            #   sign-in, token exchange, profile
│   │   ├── files.js           #   upload, download, share, ACLs, libraries wiring
│   │   ├── wopi.js            #   WOPI host for Collabora (CheckFileInfo/GetFile/PutFile)
│   │   ├── pages.js  ai.js    #   knowledge pages and AI Q&A
│   │   ├── notifications.js   #   in-app bell + email test
│   │   ├── admin.js           #   users, roles, compliance, audit-verify, access review, Seafile import
│   │   ├── settings.js        #   admin settings (masked secrets)
│   │   ├── backup.js          #   scheduled backups
│   │   └── version.js log.js security.js libraries.js
│   ├── lib/                   # Business logic (27 modules)
│   │   ├── auditLog.js        #   tamper-evident hash chain
│   │   ├── accessReview.js    #   access-review assembler + CSV
│   │   ├── compliance.js      #   frameworks, controls, probes, attestations
│   │   ├── securityHeaders.js #   baseline hardening headers
│   │   ├── email.js emailEvents.js   # Graph + SMTP, per-event gating
│   │   ├── collaboraProxy.js wopiTokens.js  # same-origin editor proxy
│   │   ├── storage.js encryption.js  # storage providers + at-rest crypto
│   │   ├── seafileMigration.js       # Seafile import engine
│   │   └── settings.js db.js documentAccess.js libraries.js ...
│   ├── middleware/            # auth.js, requireRole.js
│   └── __tests__/             # Jest + supertest (26 suites, 198 tests)
├── postgres/init/             # schema, auto-applied on first boot
├── keycloak/                  # realm export, seeded on first boot
├── docker-compose.yml         # base stack
├── docker-compose.prod.yml    # + Caddy TLS overlay
├── install.sh                 # one-command installer
├── upgrade.sh release.sh      # pin-and-deploy, cut-a-release
├── DEPLOY.md                  # per-customer onboarding runbook
└── COMPLIANCE_ROADMAP.md      # compliance milestones
```

---

## Getting started

### Prerequisites

- A Linux host (a 2 vCPU / 4 GB VM is a fine starting point).
- Docker Engine and the Docker Compose v2 plugin, with your user in the `docker` group.
- Outbound internet from the host (to pull images and reach your AI provider).
- Optional: an Anthropic API key for AI features, and a domain plus ports 80/443 for public HTTPS.

### Install (recommended)

One command clones the repo, generates strong secrets, writes `.env`, and starts the stack:

```bash
curl -fsSL https://raw.githubusercontent.com/cdburgess75/Memex/main/install.sh | bash
```

It asks a few questions (local vs public mode, admin email, Anthropic key, domain). It never reuses placeholder secrets: each deployment gets its own random Postgres, Keycloak, and encryption credentials. In-browser Office editing is enabled by default with the correct SSL mode for your choice.

For a scripted / non-interactive install:

```bash
MODE=public APP_DOMAIN=memex.example.com ADMIN_EMAIL=admin@example.com \
ANTHROPIC_API_KEY=sk-ant-... \
bash -c "$(curl -fsSL https://raw.githubusercontent.com/cdburgess75/Memex/main/install.sh)"
```

### First login

1. Open the app at the URL the installer prints.
2. Sign in with the seeded account `admin@memex.local` / `memex-admin` (you are forced to change the password on first login).
3. Sign out, then sign in as your real admin email so that account receives the admin role. Manage everything else from the UI.

For a full per-customer runbook (domain, branding, email, backups, checklist), see [DEPLOY.md](DEPLOY.md).

### Key configuration

Secrets and settings live in `.env` (generated) and are also editable in-app under Settings. The most relevant:

```bash
# Database and auth
POSTGRES_PASSWORD=...
KEYCLOAK_URL=auto                 # derive the browser URL from the request host
ADMIN_EMAILS=admin@example.com    # comma-separated; these emails get admin on first login

# AI (more providers configurable in-app)
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-6

# Storage (local | s3 | supabase)
STORAGE_PROVIDER=local
STORAGE_ENCRYPTION_KEY=...         # AES-256-GCM at rest. If lost, encrypted files are unrecoverable.

# In-browser Office editing
COLLABORA_ENABLED=true
COLLABORA_SSL_TERMINATION=true     # true behind HTTPS, false for plain-http local

# Public HTTPS
APP_URL=https://memex.example.com
TRUST_PROXY=1
```

---

## Quickstart and usage

### Run the stack manually

```bash
git clone https://github.com/cdburgess75/Memex.git && cd Memex
cp .env.example .env   # or let install.sh generate one
docker compose up -d   # base stack
# For production TLS via Caddy:
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### Update a deployment

```bash
./upgrade.sh v2026.07.11.007   # pin a release, or ./upgrade.sh for :latest
```

### Public API surface

The frontend bootstraps from a public config endpoint, then authenticates via Keycloak (PKCE). A couple of representative calls:

```bash
# Public bootstrap config (no auth): version, auth settings, branding, editing flag
curl -s http://localhost:3000/api/config

# Authenticated calls carry a bearer token from the Keycloak PKCE flow
curl -s http://localhost:3000/api/files \
  -H "Authorization: Bearer $ACCESS_TOKEN"

# Admin: verify the tamper-evident audit-log chain
curl -s http://localhost:3000/api/admin/compliance/audit-verify \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# -> { "ok": true, "count": 1284, "head": "…" }

# Admin: export the access review as CSV
curl -s http://localhost:3000/api/admin/access-review.csv \
  -H "Authorization: Bearer $ADMIN_TOKEN" -o access-review.csv
```

### Run the test suite

```bash
cd server
npm install
npm test          # Jest + supertest: 26 suites, 198 tests
npx jest lib/auditLog    # run a single suite
```

---

## Contributing

Contributions are welcome. The codebase is intentionally small and readable.

- **Frontend:** everything is in `index.html`. Match the surrounding vanilla-JS style; there is no build step or framework.
- **Backend:** add HTTP surface under `server/routes/` and logic under `server/lib/`. Keep secrets out of logs and responses.
- **Tests:** add or update Jest tests under `server/__tests__/`. Run `npm test` and keep the suite green before opening a PR.
- **Releases:** cut a release with `./release.sh`, which bumps the `VERSION` file, tags, and triggers the image build. Bump the version for every deployable change.

Please open an issue to discuss substantial changes before a large PR.

---

## License

License to be finalized. Until a `LICENSE` file is added to this repository, treat the code as all rights reserved by the maintainers. Replace this section with your chosen SPDX license (for example MIT or Apache-2.0) and add the corresponding `LICENSE` file.
