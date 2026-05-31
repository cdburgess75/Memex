# Memex

A team knowledge base where Claude does the reading, writing, and upkeep.

Most knowledge-management tools are retrieval-only — you put documents in and search them back out. Nothing accumulates. Memex is different: it **builds and maintains a persistent, interlinked wiki** that grows smarter every time your team feeds it a source. Paste an article, drop a PDF, point it at a URL, or upload a Word document — Claude summarizes it, weaves new pages into the collection, and cross-links everything that relates. Ask questions and get answers grounded in what your team has actually gathered. Run a periodic audit to catch contradictions, orphans, and gaps.

The whole thing runs in one HTML file backed by a lightweight Node.js server and a Postgres database. No proprietary platform, no vendor lock-in — your knowledge stays yours.

---

## Features

### Knowledge operations

| Operation | What it does |
|-----------|-------------|
| **Ingest** | Paste text, enter a URL, or upload a file. Claude reads the source, writes a 2–3 sentence summary, and creates or updates 2–4 interlinked wiki pages. Supports Word, Excel, PowerPoint, PDF, and plain text. |
| **Query** | Ask anything. Claude answers from what the team has gathered, names the pages it draws on, and can file the answer back as its own wiki page so insight compounds. Answers stream in real time with a Stop button. |
| **Lint** | Periodic health-check — contradictions between pages, orphaned pages with no inbound links, missing cross-references, and gaps worth chasing next. Focus on a topic or let it scan everything. |

### Team features

- **Shared wiki** — one knowledge base for the whole team, stored in Postgres
- **Google SSO** — sign in with a Google Workspace account
- **Microsoft 365 SSO** — sign in with an Azure AD / Entra account
- **Role-based access** — three roles: Admin, Contributor, Viewer. Admins manage the team; contributors ingest and edit; viewers read only.
- **Activity log** — every ingest, query, and audit is attributed to the team member who ran it
- **Admin panel** — page count, top contributors, recent activity, API cost dashboard, and team role management

### Document library

- **File upload** — drag-and-drop or pick Word, Excel, PowerPoint, PDF, CSV, and text files (up to 50 MB)
- **Supabase Storage** — files live in a private S3-compatible bucket, never in the git repo
- **Office Online viewer** — open any supported file in Microsoft Office Online directly in the browser (read-only, no account needed)
- **Office Online editor** — full in-browser editing via the WOPI protocol when `APP_URL` is configured
- **Google Drive editing** — upload to Google Drive and open in Docs/Sheets/Slides; export edits back to storage
- **Wiki ingest from file** — extract text from any document and run it through the ingest pipeline with one click

### Editor & navigation

- **Sidebar search** — filter the page index by title as you type
- **Category filter** — pill buttons filter the sidebar to a single category (Concepts, Entities, Sources, Analyses)
- **Full-text search** — Postgres `tsvector` search with highlighted excerpts across all page content
- **Inline editing** — click Edit on any page to rewrite it directly in the browser
- **Version history** — every edit saves a snapshot; preview and restore any previous version
- **Rich markdown** — fenced code blocks, pipe tables, ordered and unordered lists, H2/H3, inline code, external links, wiki-style `[[Page Links]]`
- **Dark mode** — auto-detected from your OS preference; toggle manually in the masthead

### Admin dashboard

- **Usage & cost** — token consumption and estimated spend per user, per operation, and by day (30-day window)
- **Team management** — list all users, assign or change roles (Admin / Contributor / Viewer)
- **Stats** — total page count, recent activity count, top contributors

### Portability

- **Export .md** — dumps the entire wiki as a single Markdown bundle ready for Obsidian or a git repo
- **Backup / Restore** — full JSON export and import to migrate, snapshot, or seed a new instance

---

## Architecture

```
Browser (index.html)
    │  Supabase JS SDK — auth (Google / Microsoft SSO)
    │  Fetch API — all data, AI, and file calls go through the server
    │
    ▼
Node.js / Express  (server/)
    ├─ Auth middleware    — verifies Supabase JWT on every request
    ├─ /api/pages        — CRUD, full-text search, version history
    ├─ /api/ai           — Anthropic API proxy (ingest · query · lint · extract)
    ├─ /api/files        — upload, signed URLs, Office Online, Google Drive
    ├─ /api/log          — activity log
    ├─ /api/admin        — stats, user management, usage dashboard
    └─ /wopi             — WOPI protocol server for Office Online editing
    │
    ├─ Supabase (Postgres + Auth + Storage)
    │       pages, activity_log, user_roles, page_versions,
    │       api_usage, documents tables — all with row-level security
    │       documents storage bucket (private, S3-compatible)
    │
    └─ Anthropic API  (claude-sonnet-4-6 by default)
```

The Anthropic API key lives only on the server — it is never sent to the browser. All team members share one key billed to your account.

---

## Prerequisites

- **Node.js 20+**
- **Supabase account** — [supabase.com](https://supabase.com) (free tier is sufficient to start)
- **Anthropic API key** — [console.anthropic.com](https://console.anthropic.com/settings/keys)
- **Google Cloud project** (for Google SSO and/or Google Drive editing) — [console.cloud.google.com](https://console.cloud.google.com)
- **Azure AD app registration** (for Microsoft 365 SSO) — [portal.azure.com](https://portal.azure.com)

---

## Setup

### 1. Supabase project

1. Create a new project at [supabase.com](https://supabase.com).
2. In the **SQL Editor**, run the six migrations in order:

   | File | Creates |
   |------|---------|
   | `supabase/migrations/001_initial.sql` | `pages`, `activity_log`, RLS policies |
   | `supabase/migrations/002_roles.sql` | `user_roles` table |
   | `supabase/migrations/003_full_text_search.sql` | `content_fts` column, `search_pages` RPC |
   | `supabase/migrations/004_page_versions.sql` | `page_versions` table |
   | `supabase/migrations/005_api_usage.sql` | `api_usage` table |
   | `supabase/migrations/006_documents.sql` | `documents` table, `documents` storage bucket |

3. Go to **Settings → API** and copy:
   - **Project URL** → `SUPABASE_URL`
   - **anon / public key** → `SUPABASE_ANON_KEY`
   - **service_role / secret key** → `SUPABASE_SERVICE_ROLE_KEY`

### 2. Google SSO

1. In [Google Cloud Console](https://console.cloud.google.com), create an OAuth 2.0 Client ID (Web application).
2. Add an authorised redirect URI:
   ```
   https://<your-supabase-project>.supabase.co/auth/v1/callback
   ```
3. In Supabase → **Authentication → Providers → Google**, enable Google and paste the Client ID and Client Secret.

### 3. Microsoft 365 SSO

1. In [Azure Portal](https://portal.azure.com) → **Entra ID → App registrations**, register a new application.
2. Under **Authentication**, add a redirect URI (Web):
   ```
   https://<your-supabase-project>.supabase.co/auth/v1/callback
   ```
3. Create a **Client secret** under **Certificates & secrets**.
4. In Supabase → **Authentication → Providers → Azure**, enable Azure and paste:
   - **Application (client) ID**
   - **Client secret value**
   - **Azure Tenant ID** (or `common` to allow any Microsoft account)

### 4. Google Drive editing (optional)

To let users edit files in Google Docs/Sheets/Slides:

1. In Google Cloud Console, enable the **Google Drive API** for your project.
2. Create a **Service Account** (IAM & Admin → Service Accounts).
3. Download the JSON key file.
4. Paste the entire JSON object (minified) into `GOOGLE_SERVICE_ACCOUNT_KEY`.
5. Optionally set `GOOGLE_DRIVE_FOLDER_ID` to upload files into a specific folder.

### 5. Office Online editing (optional)

Office Online editing requires the WOPI protocol. The server implements WOPI automatically — you just need to set `APP_URL` to your server's public HTTPS URL so Microsoft's servers can reach your WOPI endpoint.

> **Note:** For production use, Office Online WOPI access requires registration with Microsoft. The viewer (read-only) works without registration.

### 6. Environment variables

Copy `.env.example` to `.env` and fill in all values:

```bash
cp .env.example .env
```

```env
# Supabase — from your project's Settings → API
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_ANON_KEY=your-anon-public-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-secret-key

# Anthropic — one key shared by all users
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-6

# Admin emails (comma-separated) — these users get the 'admin' role on first login
ADMIN_EMAILS=you@yourcompany.com,colleague@yourcompany.com

# Server
PORT=3000

# Office Online editing — set to your public HTTPS URL to enable WOPI editing
APP_URL=https://your-app-url.com

# Google Drive editing — paste the full service account JSON key (minified)
GOOGLE_SERVICE_ACCOUNT_KEY={"type":"service_account","project_id":"..."}
GOOGLE_DRIVE_FOLDER_ID=optional-folder-id
```

---

## Running locally

```bash
cd server
npm install
cd ..
node server/index.js
```

Open [http://localhost:3000](http://localhost:3000). Sign in with Google or Microsoft and start ingesting.

For development with auto-restart on file changes:

```bash
cd server && npm run dev
```

---

## Deployment

### Recommended for small businesses

Two options depending on whether you prefer on-prem hardware or a cheap cloud server.

---

#### Option A — Coolify on a Hetzner VPS (easiest, ~€6/month)

[Coolify](https://coolify.io) is a self-hosted platform that gives you a Heroku-style dashboard — auto-deploy on push, SSL, reverse proxy, environment variables, one-click rollbacks — all on hardware you control.

1. **Provision a server.** Sign up at [hetzner.com](https://www.hetzner.com) and create a CX22 instance (2 vCPU, 4 GB RAM, ~€4/month). Ubuntu 24.04 LTS works well.

2. **Install Coolify** (one command, run as root):
   ```bash
   curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
   ```
   Then open `http://<your-server-ip>:8000` to finish setup.

3. **Connect your GitHub repo.** In Coolify → Sources → add GitHub. Give it access to `cdburgess75/Memex`.

4. **Create a new application.** Select the repo, set the branch to `main`, and choose *Dockerfile* as the build method. Coolify finds the `Dockerfile` automatically.

5. **Add environment variables.** Paste all values from `.env.example` into Coolify's Environment Variables tab.

6. **Set a domain.** Point an A record at the server IP, then enter the domain in Coolify. It provisions a Let's Encrypt certificate automatically.

7. **Deploy.** Click Deploy. Every future push to `main` redeploys automatically.

> From now on: push code → Coolify rebuilds → live in ~60 seconds. No SSH required for day-to-day operations.

---

#### Option B — Synology NAS (on-prem, no monthly fees)

Any Synology running DSM 7.2+ with **Container Manager** installed can run Memex.

1. **Open Container Manager** → Registry → search `ghcr.io/cdburgess75/memex` → Download (`latest` tag).

2. **Create a container.** Container Manager → Container → Create → select the `memex` image.

3. **Configure port mapping.** Map host port `3000` → container port `3000` (or choose a different host port if 3000 is taken).

4. **Add environment variables.** In the Environment tab, add each variable from `.env.example` with its value.

5. **Enable auto-restart.** Check "Enable auto-restart" so the container comes back after a NAS reboot.

6. **Apply and start.**

7. **Set up HTTPS.** In DSM → Control Panel → Login Portal → Advanced → Reverse Proxy, add a rule forwarding your domain (or a DDNS hostname from Synology's free DDNS service) to `localhost:3000`. Enable Let's Encrypt for the domain in DSM → Security → Certificate.

> Memex will be available at `https://your-domain.synology.me` (or your custom domain) and survive NAS reboots automatically.

---

### Docker Compose

The repo includes a `docker-compose.yml`. Copy your `.env` file to the same directory and run:

```bash
docker compose up -d
```

To pull the latest image and restart:

```bash
docker compose pull && docker compose up -d
```

To build from source instead of using the pre-built image, uncomment the `build: .` line in `docker-compose.yml` and remove or comment out the `image:` line.

### Docker (single container)

```bash
docker pull ghcr.io/cdburgess75/memex:latest
docker run -d --name memex --restart unless-stopped \
  -p 3000:3000 --env-file .env \
  ghcr.io/cdburgess75/memex:latest
```

### Railway

1. Connect your GitHub repo in [Railway](https://railway.app).
2. Railway detects the `Dockerfile` automatically.
3. Add the environment variables in the Railway dashboard.
4. Deploy.

### Fly.io

```bash
fly launch          # detects Dockerfile, prompts for region
fly secrets set SUPABASE_URL=... SUPABASE_ANON_KEY=... # etc.
fly deploy
```

### Azure App Service

1. Push the GHCR image or connect your GitHub repo.
2. In Azure → **App Service → Configuration**, add the environment variables.
3. Set the startup command to `node server/index.js` if not using Docker directly.

### Kubernetes

The app is a stateless single-container workload. A minimal deployment:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: memex
spec:
  replicas: 1
  selector:
    matchLabels:
      app: memex
  template:
    metadata:
      labels:
        app: memex
    spec:
      containers:
        - name: memex
          image: ghcr.io/cdburgess75/memex:latest
          ports:
            - containerPort: 3000
          envFrom:
            - secretRef:
                name: memex-env
```

Create the secret from your `.env` file:
```bash
kubectl create secret generic memex-env --from-env-file=.env
```

### Other platforms

Memex is a single stateless container and runs on any platform that supports Docker: **Portainer**, **Unraid**, **TrueNAS SCALE**, **Coolify**, **Caprover**, **GCP Cloud Run**, **AWS App Runner**, **Azure Container Apps**, and bare VMs running Node.js directly with `pm2` or `systemd`.

---

## Next steps

The core feature set is complete. Here is what makes the most sense to build next, roughly in order of impact:

### Near term
- **Slack / Teams bot** — let team members query the wiki from a chat command without opening the browser
- **Webhook on ingest** — fire a notification (Slack, email, webhook) when new pages are created, so the team knows the collection grew

### Longer term
- **Granular permissions per page or category** — some pages may be sensitive (HR, legal). Row-level security is already in place; adding a `visibility` column is straightforward.
- **Scheduled lint** — run the wiki audit automatically on a cron and email the report to admins
- **Embedding-based semantic search** — use Anthropic embeddings to find pages by meaning rather than keyword match. Supabase has `pgvector` built in.
- **Mobile app** — the responsive layout works on phones, but a native wrapper (Capacitor / React Native) would allow push notifications and offline reading

---

## Open source credits

See [GUMBO.md](GUMBO.md) for the full list of open source libraries and fonts that make this possible.

---

## Origin

The name and concept come from Vannevar Bush's 1945 essay *As We May Think*, in which he described the Memex — a private, associative knowledge store with trails between documents. Bush couldn't solve who does the maintenance. An LLM can.

---

## License

MIT — see [LICENSE](LICENSE).
