# Memex → Small-Business File Store: Recommendations

> **Status note (2026-07-16): this document is largely historical.** Most of Phase 1 and Phase 2
> below have since shipped (TLS via Caddy, rate limiting, trash, full-text search, secure share
> links, external upload links, folders, document versioning, notifications, per-document access
> control). The prerequisite it opens with ("runs at plain HTTP, SSO is dead") is resolved. For the
> current, reconciled status of every item and the ranked list of what is still open, see
> **`REMEDIATION_PLAN.md`** (which supersedes this file for planning). The text below is kept for
> context and design rationale.

## Executive summary

Memex is closer to a real file store than it looks. It already has **pluggable storage**
(local / S3 / Supabase), **AES-256-GCM encryption** (local only), **Keycloak SSO with roles**,
an **activity log**, a **runtime admin panel**, and a **text-extraction pipeline**. What it
completely lacks is the thing actually wanted: **any way to share with or collect from people
who don't have an account.** Today access is all-or-nothing by role — no folders, no per-file
permissions, no share links, no external upload. Getting to "secure primary file store with
outside upload and large-file sharing" is mostly *additive* work on a sound architecture,
gated behind one hard prerequisite.

## ⚠️ Prerequisite that blocks almost everything: HTTPS + a real hostname

Memex runs at `http://192.168.1.32` — plain HTTP on a LAN IP. Consequence already hit:
`crypto.subtle` doesn't exist on insecure origins, which is why SSO is dead and we're on a
password-grant workaround. The same constraint makes **every external-facing feature unsafe** —
share/upload links over plain HTTP leak their tokens in transit.

**Fix:** put a **Caddy** (or Traefik) reverse proxy in front of the app. Caddy auto-provisions
TLS — Let's Encrypt with a real domain (e.g. `files.ptechllc.com`) if internet-reachable, or an
internal CA cert for LAN-only use. Then point `APP_URL`/`KEYCLOAK_URL` at the HTTPS host, set
`TRUST_PROXY=true`, and lock `CORS_ORIGINS` down from `*` to the one origin.
**Effort: quick-win. Unblocks SSO and is a hard dependency for nearly all of Phase 2.**

---

## Phase 1 — Foundation & quick wins

| Item | What / why | Effort | Depends on |
|---|---|---|---|
| **TLS via Caddy** | HTTPS + hostname; restores SSO, enables everything external | quick-win | DNS or LAN cert |
| **Download/read audit logging** | Log every download/list/delete to existing `activity_log` (today only ingest/query logged) | quick-win | TRUST_PROXY for real IPs |
| **Rate limiting** | `express-rate-limit` on public/auth-light routes keyed by IP+token — mandatory before any public surface | quick-win | TRUST_PROXY |
| **Trash / soft-delete** | `deleted_at` column instead of hard delete + 30-day restore — insurance against mis-click delete | quick-win | schema add |
| **Full-text document search** | Persist text the ingest pipeline already extracts into a Postgres `tsvector` GIN index | moderate | extracted_text column + backfill |
| **Org/per-user storage quota** | `SUM(documents.size)` against a configurable cap; surfaced in admin panel | quick-win | none |

## Phase 2 — Core file-store capabilities

| Item | What / why | Effort | Depends on |
|---|---|---|---|
| **Secure share links** | `share_links` table (hashed token, expiry, max-downloads, optional password, revoke); public `/share/:token` route streams the file, authorizing on token alone. The #1 missing capability. | moderate | HTTPS, share_links table |
| **Password / download-cap / revoke** | Columns on the same table + atomic counter; instant kill-switch for leaked links | quick-win | share_links |
| **External upload links ("file requests")** | `upload_requests` table + public `/u/:token` page; outsiders drop files without a Keycloak account, tagged `source=external`. Avoids guest accounts entirely. | moderate | rate limiting, virus scan |
| **Large-file delivery (presigned URLs)** | For S3/R2, 302-redirect to short-TTL presigned URL instead of proxying bytes through Node — free HTTP range/resume, offloaded egress | moderate | S3/R2 backend |
| **Large-file upload (presigned multipart)** | `upload/init` + `upload/complete`; browser PUTs parts to the bucket. Removes 50MB ceiling (→ multi-GB), resumable | significant | S3/R2 + bucket CORS |
| **Folders / spaces** | `folders` table + `folder_id` on documents; the unit an SMB thinks in. Prereq for permissioning | moderate | schema + migration |
| **Per-folder ACLs + guest role** | `folder_acl` (user/group → folder → view/contribute/manage) in middleware; 4th `guest` role limited to granted/external folders | significant | folders, groups |
| **Teams via Keycloak groups** | Map Keycloak groups → JWT `groups` claim → folder grants; onboarding = one group-add | moderate | folders, ACL |

## Phase 3 — Maturity, security depth & scale

| Item | What / why | Effort | Depends on |
|---|---|---|---|
| **Backend-agnostic encryption (envelope)** | Stream wrapper with per-document data keys wrapped by one KEK; closes the gap that S3/Supabase get zero Memex-level encryption | moderate | schema (4 columns) |
| **Key rotation** | Rewrap DEKs with a new KEK (seconds, not re-encrypting TBs); admin-panel button | moderate | envelope encryption |
| **Virus/malware scanning** | ClamAV sidecar gating every upload before storage/ingest. Non-negotiable before external upload | moderate | clamd container |
| **Secrets hardening** | Move secrets off plaintext `.env` into Docker secrets / SOPS; store only pointers in Postgres | moderate | key-custody decision |
| **Encrypted, tested backups** | Scheduled `pg_dump` + object manifest to a separate bucket/credential, encrypted | moderate | second bucket |
| **S3/R2 as default backend** | Demote local to dev-only; R2/B2 give 11-nines durability + cheap egress vs. a single disk on one box | moderate | bucket + SSE |
| **Document versioning** | Mirror existing `page_versions` pattern for documents — roll back a clobbered file | moderate | schema |
| **Dedup + lifecycle tiering + retention** | SHA-256 content-addressing (30-50% savings), cold-tier transitions, auto-expire external prefix | mixed | S3 |
| **Notifications** | Email/Slack webhook to link owner on external upload | quick-win | settings keys |

---

## Recommended next 3 steps

1. **Stand up HTTPS with Caddy + a hostname.** Nothing external is safe or functional until
   this is done; it also restores real SSO immediately.
2. **Ship audit-logging + rate-limiting + trash quick wins** — small, high-value, and the
   safety prerequisites the public features depend on.
3. **Build secure share links first, then external upload links** (with ClamAV gating uploads).
   These are the literal core of "let outsiders securely send and receive files."

## Note on non-member uploads

The right pattern is **scoped, expiring, single-purpose tokens — not guest accounts.** A
contributor generates a "send me files here" link; outsiders use a stripped-down public page
that never touches Keycloak; files land quarantined until ClamAV clears them. This keeps
strangers entirely out of the auth/role model while still attributing and auditing every upload.

---

*Generated from a 6-dimension multi-agent design pass (access control, operational features,
secure sharing, external upload, storage/scale, security/compliance) grounded in the current
codebase.*
