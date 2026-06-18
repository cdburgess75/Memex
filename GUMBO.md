# GUMBO

Open source software used in this project. Thank you to every author and contributor.

---

## Frontend

The frontend is a single, dependency-free HTML file — vanilla JavaScript, no framework, no build step. Authentication uses the Keycloak OIDC endpoints directly via the browser's `fetch` and the PKCE flow (no auth SDK).

### Inter
- **Type:** Variable UI font (Google Fonts) — used for display, body, and UI text
- **License:** SIL Open Font License 1.1
- **Source:** https://github.com/rsms/inter
- **Author:** Rasmus Andersson

Monospace text uses the system font stack (`ui-monospace`, SF Mono, Menlo) — no bundled monospace font.

---

## Server (`server/`)

| Package | Purpose | License | Source |
|---------|---------|---------|--------|
| `express` | HTTP server / routing | MIT | https://github.com/expressjs/express |
| `cors` | CORS middleware | MIT | https://github.com/expressjs/cors |
| `express-rate-limit` | Request rate limiting | MIT | https://github.com/express-rate-limit/express-rate-limit |
| `dotenv` | Env-file loading | BSD-2-Clause | https://github.com/motdotla/dotenv |
| `pg` | PostgreSQL client | MIT | https://github.com/brianc/node-postgres |
| `jsonwebtoken` | JWT decode/verify | MIT | https://github.com/auth0/node-jsonwebtoken |
| `jwks-rsa` | Keycloak JWKS key retrieval | MIT | https://github.com/auth0/node-jwks-rsa |
| `@anthropic-ai/sdk` | Claude API client | MIT | https://github.com/anthropics/anthropic-sdk-node |
| `openai` | OpenAI-compatible API client (OpenAI, Groq, Ollama, vLLM, …) | Apache-2.0 | https://github.com/openai/openai-node |
| `undici` | HTTP client (proxy-aware URL fetching) | MIT | https://github.com/nodejs/undici |
| `cheerio` | HTML parsing for URL ingest | MIT | https://github.com/cheeriojs/cheerio |
| `multer` | Multipart file uploads | MIT | https://github.com/expressjs/multer |
| `pdf-parse` | PDF text extraction | MIT | https://gitlab.com/autokent/pdf-parse |
| `mammoth` | `.docx` text extraction | BSD-2-Clause | https://github.com/mwilliamson/mammoth.js |
| `xlsx` (SheetJS) | Spreadsheet parsing | Apache-2.0 | https://github.com/SheetJS/sheetjs |
| `@aws-sdk/client-s3` | S3-compatible storage (AWS, R2, B2, MinIO, Spaces) | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3 |
| `@aws-sdk/s3-request-presigner` | Signed S3 URLs | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3 |
| `@supabase/supabase-js` | Supabase Storage provider (optional/legacy) | MIT | https://github.com/supabase/supabase-js |
| `googleapis` | Google Drive editing | Apache-2.0 | https://github.com/googleapis/google-api-nodejs-client |

### Dev dependencies

| Package | Purpose | License | Source |
|---------|---------|---------|--------|
| `jest` | Test runner | MIT | https://github.com/jestjs/jest |
| `supertest` | HTTP assertions for route tests | MIT | https://github.com/ladjs/supertest |

---

## Infrastructure

### Node.js
- **License:** MIT
- **Source:** https://github.com/nodejs/node

### PostgreSQL
- **Role:** Primary database
- **License:** PostgreSQL License
- **Source:** https://www.postgresql.org

### Keycloak
- **Role:** Authentication / OIDC identity provider (with optional Google / Microsoft brokering)
- **License:** Apache License 2.0
- **Source:** https://github.com/keycloak/keycloak

### Docker
- **License:** Apache License 2.0
- **Source:** https://github.com/moby/moby

### Supabase (platform)
- **Role:** Optional — only when using the Supabase Storage provider
- **License:** Apache License 2.0
- **Source:** https://github.com/supabase/supabase
