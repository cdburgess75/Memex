# Memex

A team knowledge base where Claude does the reading, writing, and upkeep.

Most knowledge-management tools are retrieval-only — you put documents in and search them back out. Nothing accumulates. Memex is different: it **builds and maintains a persistent, interlinked wiki** that grows smarter every time your team feeds it a source. Paste an article, drop a PDF, or point it at a URL; Claude summarizes it, weaves new pages into the collection, and cross-links everything that relates. Ask questions and get answers grounded in what your team has actually gathered. Run a periodic audit to catch contradictions, orphans, and gaps.

The whole thing runs in one HTML file backed by a lightweight Node.js server and a Postgres database. No proprietary platform, no vendor lock-in — your knowledge stays yours.

---

## Features

### Knowledge operations
| Operation | What it does |
|-----------|-------------|
| **Ingest** | Paste text, drop a PDF, or enter a URL. Claude reads the source, writes a 2–3 sentence summary, and creates or updates 2–4 interlinked wiki pages. |
| **Query** | Ask anything. Claude answers from what the team has gathered and names the pages it draws on. Optionally file the answer back as its own page so insight compounds. |
| **Lint** | Periodic health-check — contradictions between pages, orphaned pages with no inbound links, missing cross-references, and gaps worth chasing next. |

### Team features
- **Shared wiki** — one knowledge base for the whole team, stored in Postgres
- **Google SSO** — sign in with a Google Workspace account
- **Microsoft 365 SSO** — sign in with an Azure AD / Entra account
- **Activity log** — every ingest, query, and audit is attributed to the team member who ran it
- **Admin panel** — page count, top contributors, recent activity

### Editor
- **Sidebar search** — filter the page index by title as you type
- **Inline editing** — click Edit on any page to rewrite it directly
- **Rich markdown** — fenced code blocks, pipe tables, ordered lists, H2/H3, inline code, external links, wiki-style `[[Page Links]]`
- **Dark mode** — toggle in the masthead

### Portability
- **Export .md** — dumps the entire wiki as a single Markdown bundle ready for Obsidian or a git repo
- **Backup / Restore** — full JSON export and import to migrate or snapshot the collection

---

## Architecture

```
Browser (index.html)
    │  Supabase JS SDK — auth (Google / Microsoft SSO)
    │  Fetch API — all data and AI calls go through the server
    │
    ▼
Node.js / Express  (server/)
    ├─ Auth middleware — verifies Supabase JWT on every request
    ├─ /api/pages     — CRUD for wiki pages (Postgres via Supabase)
    ├─ /api/ai        — Anthropic API proxy (ingest · query · lint · extract)
    ├─ /api/log       — activity log
    └─ /api/admin     — stats for the admin panel
    │
    ├─ Supabase (Postgres + Auth)
    │       pages table, activity_log table, row-level security
    │
    └─ Anthropic API  (claude-sonnet-4-6 by default)
```

The Anthropic API key lives only on the server — it is never sent to the browser. All team members share one key billed to your account.

---

## Prerequisites

- **Node.js 20+**
- **Supabase account** — [supabase.com](https://supabase.com) (free tier is sufficient to start)
- **Anthropic API key** — [console.anthropic.com](https://console.anthropic.com/settings/keys)
- **Google Cloud project** (for Google SSO) — [console.cloud.google.com](https://console.cloud.google.com)
- **Azure AD app registration** (for Microsoft 365 SSO) — [portal.azure.com](https://portal.azure.com)

---

## Setup

### 1. Supabase project

1. Create a new project at [supabase.com](https://supabase.com).
2. In the **SQL Editor**, run the migration at `supabase/migrations/001_initial.sql`. This creates the `pages` and `activity_log` tables and enables row-level security.
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

### 4. Environment variables

Copy `.env.example` to `.env` and fill in all values:

```bash
cp .env.example .env
```

```env
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_ANON_KEY=your-anon-public-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-secret-key

ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-6

PORT=3000
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

### Docker

Build and run the image locally:

```bash
docker build -t memex .
docker run -p 3000:3000 --env-file .env memex
```

### GitHub Container Registry

Every push to `main` automatically builds and pushes a Docker image to GHCR via the workflow in `.github/workflows/pages.yml`. Pull and run it on any server:

```bash
docker pull ghcr.io/cdburgess75/memex:latest
docker run -p 3000:3000 --env-file .env ghcr.io/cdburgess75/memex:latest
```

### Railway

1. Connect your GitHub repo in [Railway](https://railway.app).
2. Railway will detect the `Dockerfile` automatically.
3. Add the five environment variables in the Railway dashboard.
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

---

## Next steps

The foundation is in place. Here is what makes the most sense to build next, roughly in order of impact:

### Near term
- **Role-based access control** — distinguish admins (can erase pages, manage users) from contributors (ingest/edit) and viewers (query only). Currently all authenticated users have full access.
- **Full-text search** — search inside page *content*, not just titles. Can be done with Postgres `tsvector` / `to_tsquery` at zero extra cost.
- **Page version history** — store a `page_versions` table so edits can be compared or rolled back.

### Medium term
- **Usage and cost dashboard** — track Anthropic API token spend per user per month so you can see who is using the wiki and what it costs.
- **Slack / Teams bot** — let team members query the wiki from a chat command without opening the browser.
- **Webhook on ingest** — fire a notification (Slack, email, webhook) when a new page is created, so the team knows the collection grew.

### Longer term
- **Granular permissions per page or category** — some pages may be sensitive (HR, legal). Row-level security is already in place; adding a `visibility` column is straightforward.
- **Scheduled lint** — run the wiki audit automatically on a cron and email the report to admins.
- **Embedding-based semantic search** — use Anthropic embeddings to find pages by meaning rather than keyword match. Supabase has `pgvector` built in.
- **Mobile app** — the responsive layout works on phones, but a native wrapper (Capacitor / React Native) would allow push notifications and offline reading.

---

## Open source credits

See [GUMBO.md](GUMBO.md) for the full list of open source libraries and fonts that make this possible.

---

## Origin

The name and concept come from Vannevar Bush's 1945 essay *As We May Think*, in which he described the Memex — a private, associative knowledge store with trails between documents. Bush couldn't solve who does the maintenance. An LLM can.

---

## License

MIT — see [LICENSE](LICENSE).
