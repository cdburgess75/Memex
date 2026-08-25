# Connecting Depot to a customer's Microsoft 365 (Graph)

Per-customer, in the **customer's own** Entra tenant, with a **certificate**
credential. Never a shared multi-tenant app: a shared credential on every
deployment means one compromised box endangers every tenant that consented.
~30–45 minutes with the customer's Global Administrator on a screen-share.

> Draft status: steps are current as written; validate once against a real
> tenant and strike this note.

What this enables, both optional:
- **Outbound mail** (share notifications, meeting invites) via `Mail.Send`.
- **The SharePoint connector** (Settings → Connections) via `Sites.Selected`.

## 0. Before the session (ParaTech side)

Generate the certificate credential — from the fleet repo:

```bash
bin/make-graph-cert.sh <slug>
```

That emits `<slug>-graph.key.pem` (private — destined only for the customer VM)
and `<slug>-graph.cer` (public — uploaded to Entra below), and prints the SHA-1
thumbprint + expiry for the fleet manifest.

## 1. App registration (Global Admin, Entra portal)

1. **Entra admin center → App registrations → New registration**
   - Name: `Depot (<Customer>)` — single tenant. No redirect URI (app-only).
2. **Certificates & secrets → Certificates → Upload certificate** → the `.cer`.
   Confirm the thumbprint matches what `make-graph-cert.sh` printed.
3. **API permissions → Add → Microsoft Graph → Application permissions**:
   - `Mail.Send` (if mail is wanted)
   - `Sites.Selected` (if the SharePoint connector is wanted)
   Then **Grant admin consent**. Remove the default delegated `User.Read` — unused.
4. Record for the manifest: **Directory (tenant) ID**, **Application (client) ID**.

## 2. Scope it down (PowerShell, still the admin)

`Sites.Selected` grants access to **zero** sites until each one is granted:

```powershell
Connect-MgGraph -Scopes "Sites.FullControl.All"
# site id: Get-MgSite -Search "<site name>"
New-MgSitePermission -SiteId <site-id> -BodyParameter @{
  roles = @("write")
  grantedToIdentities = @(@{ application = @{ id = "<app-client-id>"; displayName = "Depot (<Customer>)" } })
}
```

Confine `Mail.Send` to the designated sender mailbox (otherwise app-only
Mail.Send can send as anyone in the tenant):

```powershell
Connect-ExchangeOnline
New-DistributionGroup -Name "Depot Senders" -Type Security   # add the sender mailbox, e.g. depot@customer.com
New-ApplicationAccessPolicy -AppId <app-client-id> -PolicyScopeGroupId "Depot Senders" `
  -AccessRight RestrictAccess -Description "Depot may send only as its own mailbox"
Test-ApplicationAccessPolicy -AppId <app-client-id> -Identity depot@customer.com   # → Granted
Test-ApplicationAccessPolicy -AppId <app-client-id> -Identity ceo@customer.com     # → Denied
```

## 3. Wire the box (ParaTech, over the tailnet)

```bash
# key onto the VM — then DELETE the local copy
scp <slug>-graph.key.pem root@depot-<slug>:/opt/memex/secrets/graph.key.pem
ssh root@depot-<slug> 'chmod 600 /opt/memex/secrets/graph.key.pem'
```

Settings (Setup Wizard step 3 during handoff, or seeded via provisioning psql):

| setting | value |
|---|---|
| `email_provider` | `graph365` |
| `email_from` | `depot@customer.com` (the policy-scoped mailbox) |
| `graph_tenant_id` | tenant ID from step 1 |
| `graph_client_id` | app ID from step 1 |
| `graph_cert_thumbprint` | from `make-graph-cert.sh` |
| `graph_cert_key_path` | `/secrets/graph.key.pem` |

Using `graph_cert_key_path` (not the `graph_cert_key` DB setting) keeps the
private key out of the database — and therefore out of every backup dump.

For the SharePoint connector: Settings → Connections → New → SharePoint, same
tenant/client/cert values, site URL = a granted site.

## 4. Verify

- Setup Wizard → Integrations → **Send test email** (or `POST /api/setup/test/email`).
- Connections → the SharePoint connector → **Test**.
- Fleet manifest updated: `m365.tenant_id`, `app_id`, `cert_thumbprint`,
  `cert_expires`, `sites_selected`, `mail_sender`.

## 5. Lifecycle

- Certificates last 730 days; `cert_expires` in each manifest is checked at the
  quarterly fleet review. Renewal = new `make-graph-cert.sh` run, upload the new
  `.cer` (the app can hold two during rotation), replace `/secrets/graph.key.pem`,
  update thumbprint setting, delete the old cert in Entra.
- Offboarding = the customer's admin deletes the app registration; access dies
  tenant-side regardless of what happens to the box.
