# Deploying a new Memex instance

A repeatable checklist for standing up Memex on a fresh server for a customer.
One Memex instance serves one organization. Repeat this per customer.

Time: about 10 to 15 minutes of hands-on work, plus DNS propagation and (for
email) the one-time 365 setup.

---

## 0. Prerequisites

- A Linux server (a small VM is fine: 2 vCPU / 4 GB RAM / 40 GB disk to start).
- Docker Engine + the Compose v2 plugin installed, and your user in the `docker`
  group. Install guide: https://docs.docker.com/engine/install/
- Outbound internet from the server (to pull images and reach the Anthropic API).
- An Anthropic API key for AI features (optional, but recommended).

---

## 1. Install

SSH to the server and run the one-command installer:

```bash
curl -fsSL https://raw.githubusercontent.com/cdburgess75/Memex/main/install.sh | bash
```

It generates strong secrets, asks a few questions, writes `.env`, pulls the
prebuilt image, and starts the stack (Postgres + Keycloak + app + Collabora).

Answer the prompts:

| Prompt | Local (LAN / testing) | Public (customer go-live) |
|---|---|---|
| Mode | `local` | `public` |
| App image | `prebuilt` | `prebuilt` |
| Admin email | the customer admin's email | same |
| Anthropic key | paste, or blank to skip | same |
| Public domain | (not asked) | `memex.customer.com` |

You can also run it fully non-interactively by pre-setting the env vars, e.g.:

```bash
MODE=public APP_DOMAIN=memex.customer.com ADMIN_EMAIL=admin@customer.com \
ANTHROPIC_API_KEY=sk-ant-... \
bash -c "$(curl -fsSL https://raw.githubusercontent.com/cdburgess75/Memex/main/install.sh)"
```

In-browser Office editing (Collabora) is enabled by default, with the correct
SSL mode for whichever Mode you chose.

---

## 2. First login

1. Open the app (the installer prints the URL).
2. Sign in with the seeded account:
   - Email: `admin@memex.local`
   - Password: `memex-admin` (you are forced to change it on first login)
3. Sign out, then sign in as the customer admin email you provided so that
   account gets the admin role. From then on, manage everything from the UI.

---

## 3. Go live on the domain (public mode only)

1. DNS: point an `A` record for `memex.customer.com` at the server's public IP.
2. Firewall / router: forward TCP `80` and `443` to the server.
3. In Memex: Settings, System, set App URL to `https://memex.customer.com`.
4. Visit the domain. Caddy issues a Let's Encrypt certificate automatically on
   the first request. Give it a minute the first time.

The App URL setting matters: it is the canonical link used in share links and is
required for the Office editor to build correct same-origin URLs.

---

## 4. Verify Office editing

Open any Word or Excel file, click Edit. The Collabora editor should load and be
editable. If it is blank:

- Confirm `.env` has `COLLABORA_ENABLED=true`.
- Public/HTTPS deployments must have `COLLABORA_SSL_TERMINATION=true`; plain-http
  local deployments must have `false`. The installer sets this from the Mode, but
  a hand-edited `.env` can drift. After changing it: `docker compose up -d app`.

---

## 5. Workspace branding (per customer)

Settings, Workspace:

- Workspace name (shown in the header and on the sign-in screen).
- Logo (PNG/SVG up to 256 KB; transparent looks best).
- Default accent color.

This is server-set and applies to everyone, including the sign-in page.

---

## 6. Email notifications (per customer, optional)

Memex sends in-app notifications with no setup. To also send email, configure a
provider in Settings, Email.

**Microsoft Graph (recommended, durable).** App-only `sendMail` from a mailbox in
the customer's tenant. One-time 365 setup with admin PowerShell:

1. Add the `Mail.Send` application permission (role id
   `b633e1c5-b582-4048-a93e-9f11b44c7e96`) to the app registration and grant admin
   consent in the customer tenant.
2. Restrict the app to a single sender mailbox with an Exchange
   `ApplicationAccessPolicy` (RestrictAccess) scoped to a mail-enabled security
   group containing only that mailbox.
3. Provide a client secret or a certificate. For a certificate, export the
   unencrypted private key: `openssl pkcs12 -in app.pfx -nocerts -nodes -legacy -out graph.key`.
4. In Settings, Email: Provider = Microsoft Graph, From address = the sender
   mailbox, Tenant ID, Client (app) ID, and either the client secret or the cert
   thumbprint + PEM key. Save, then Send test email.

See the security note below about credential blast radius.

**SMTP (fallback).** Works on any deployment: set host, port, encryption, and
credentials in Settings, Email.

**Per-event toggles.** Settings, Email, Email notifications: choose which events
send mail (file shared, share link downloaded, upload received, document edited).

---

## 7. Storage and the encryption key (important)

Local filesystem storage is the default, with AES-256-GCM at rest. The key lives
in `.env` as `STORAGE_ENCRYPTION_KEY`.

- Back up each deployment's `.env` somewhere safe and separate from the server.
- If you lose `STORAGE_ENCRYPTION_KEY`, the encrypted files are unrecoverable.

To use S3-compatible object storage instead, configure it in Settings, System,
File Storage.

---

## 8. Scheduled backups

Settings, System, Scheduled backups: back up the database and documents on a
schedule to one or more destinations, with retention pruning. Turn this on for
every customer.

---

## 9. Updates

Pull a specific release on each host:

```bash
cd /opt/memex     # wherever this deployment lives
./upgrade.sh v2026.07.11.003    # or ./upgrade.sh to take :latest
```

If you deploy from a source checkout instead of the prebuilt image:

```bash
cd /opt/memex && git checkout -- VERSION && git pull --ff-only && docker compose up -d --build app
```

Open tabs auto-detect a new version and show a "Memex was updated, Refresh"
banner within a few minutes.

---

## Quick per-customer checklist

- [ ] Server has Docker; user in docker group
- [ ] Ran install.sh (public mode for go-live)
- [ ] DNS A record + forward 80/443 (public)
- [ ] First login, changed the seeded password, promoted the customer admin
- [ ] Set App URL (public)
- [ ] Verified Office editing loads
- [ ] Workspace branding (name, logo, accent)
- [ ] Email provider configured + test email sent (optional)
- [ ] Scheduled backups on
- [ ] Backed up this deployment's `.env` (encryption key!)

---

## Security note: shared 365 app credential

If you reuse a powerful multi-tenant app registration for Graph email, the
credential placed on the Memex server can, in principle, exercise every
permission that app has consented to (not only Mail.Send). The
`ApplicationAccessPolicy` limits the mail scope to one mailbox, but not the app's
other permissions. For the tightest blast radius, register a dedicated
`Mail.Send`-only app per the same steps and use its credential instead. This is a
drop-in swap: only the Tenant ID / Client ID / secret-or-cert in Settings change.
