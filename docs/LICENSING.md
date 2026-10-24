# Licensing

How a Depot server knows what it is entitled to, and what an operator can check or change. The commercial terms are in `LICENSE`; this page is the mechanism.

## The file

Every server carries one `license.json`: a JSON payload signed with Ed25519 by ParaTech. The server holds only public keys, so it can verify a license but never make one. Anything wrong with the file, the signature or the key fails closed: the server reports an `unlicensed` state rather than guessing.

| Where | What |
|-------|------|
| `/secrets/license.json` in the container (`LICENSE_FILE`) | the signed file, dropped by provisioning |
| `keys/*.pem` in the image (`LICENSE_PUBLIC_KEYS_DIR`, default `/app/keys`) | every public key the server trusts |
| `LICENSE_PUBLIC_KEY`, `LICENSE_PUBLIC_KEY_PATH` | one more key, inline or by path |

These are read from the container environment only. They are deliberately not settings, so a workspace admin cannot repoint the trust anchor or the file.

## The payload

A file without `v` is a version 1 license: unbound to any address, never expires, entitles updates through `updates_until`. Version 2 adds the fields the server can enforce.

| Field | Meaning |
|-------|---------|
| `v` | `2` |
| `id` | the serial, `<slug>-<number>`. Once a server has accepted a serial it refuses a lower one, which is how a re-issued license supersedes an old one |
| `kid` | which trusted public key signed it: the first 16 hex characters of SHA-256 over the key's DER. The signer fills it in |
| `customer`, `slug` | who it is for |
| `domain` | must equal the host of the server's `app_url` setting. `"*"` means unbound |
| `type` | `standard` or `trial` |
| `plan` | shown to admins, not enforced |
| `issued`, `expires` | the software term; `expires: null` means perpetual |
| `updates_until` | the maintenance term; updates stop after it |
| `grace_days` | how long after `expires` the server stays usable before read-only. Default 30 |
| `seats`, `seat_policy` | how many accounts, and whether the cap is `soft` (allow and flag) or `hard` (refuse). `null` seats means unlimited |
| `storage_gb` | the most the workspace quota may be set to. `null` means unlimited |
| `features` | named features such as `updates`, `editor`, `api`. Absent means everything |

Dates are `YYYY-MM-DD` and last through the end of that day, UTC.

## States

| State | When | What it means |
|-------|------|---------------|
| `ok` | accepted, more than 30 days of term left, or perpetual | nothing to do |
| `expiring` | 30 days or fewer of term left | renew |
| `lapsed` | term ended, inside the grace period | no new accounts, no updates |
| `readonly` | term ended and the grace period is over | the server is read-only until renewed |
| `unlicensed` | no file, bad signature, unknown key, wrong domain, lower serial | as `lapsed`, and as `readonly` 30 days after it was first seen |

A read-only server still signs people in and lets them browse, download, and use share links. Nobody is ever locked away from their files.

The state is recorded, reported (Software update, `GET /api/license`, `GET /api/v1/admin/license`), warned about, and enforced as below.

## Enforcement

| State | What changes |
|-------|--------------|
| `lapsed`, or a file that is present but not accepted | no new accounts (a first sign-in is refused with `LICENSE_SEAT_FREEZE`); no updates |
| `readonly` | changes to content are refused with `403 LICENSE_READONLY`: uploads, new folders, renames, moves, deletes, shares, library and group changes, editor saves, link uploads, the public API's writes, the drive's writes. The editor opens documents read-only. Reads, downloads, share links, sign-in and everything an administrator needs to repair the license keep working |
| no file at all | new accounts are still admitted during the 30-day grace, so a fresh install can let its first administrator in; read-only after it |

Seats: with a `seats` cap, a first sign-in past the cap is admitted under `soft` policy and the administrators are told once a day (`license_seats_exceeded` in the audit log); under `hard` policy it is refused with `SEAT_LIMIT`. Outside people on share links never count.

Features: `editor` absent means in-browser editing cannot be switched on and is not offered; `api` absent means no personal access tokens can be made and existing ones are refused, which also stops the drive. A license without a feature list includes everything; so does a license that was not accepted, whose grace period and read-only state do the work instead.

`LICENSE_ENFORCE=off` in the container environment turns enforcement off for development and evaluation installs. Reporting and warnings are unaffected. Provisioned servers never set it.

## Warnings

A minute after boot and once a day after that, the server evaluates its license and tells every administrator who is not switched off when something needs doing, once per step:

| When | Notice |
|------|--------|
| 30, 14, 7 and 1 days before `expires`, and on the day | term ends in N days |
| the day after `expires` | term ended; read-only from the grace end |
| the day after the grace period | read-only until renewed |
| any `unlicensed` state | no valid license, with the reason |
| good standing after any of the above | renewed, nothing to do |

Each notice is an in-app notification and an email to the administrator's address. ParaTech ops is an administrator on every managed box, so it receives the same notices. Administrators also see a banner in the app while the license needs attention; Details opens Software update. State changes and notices are written to the audit log as `license_state_changed` and `license_notice`.

`scripts/depot-check.sh` reports `license=ok`, `license=expiring:12d`, `license=lapsed`, `license=readonly` or `license=invalid:<reason>`. Expiring inside 14 days is WARN; lapsed, read-only or not accepted is CRIT.

## Checking a server

```bash
cd /opt/memex && docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T app \
  node -e 'require("./server/lib/license").status().then(s => console.log(JSON.stringify(s, null, 2)))'
```

`accepted` is the one to look at: the file verified, the domain matched and the serial was not lower than one already seen. `state` and `stateReason` say why when it did not.

## What the server remembers

Two rows in `system_settings`, written by the server and invisible to the settings API:

- `license_serial_seen`: the highest serial accepted so far.
- `license_unlicensed_since`: when an `unlicensed` state was first recorded; cleared when a license is accepted again.

To reinstall an older license on purpose, or after a customer's slug changes:

```sql
DELETE FROM system_settings WHERE key IN ('license_serial_seen', 'license_unlicensed_since');
```

## Keys

`scripts/license-keygen.sh` makes a pair and prints its key id. The private key lives outside every repository and must be backed up. To rotate, make a second pair, ship its public key in `keys/` in a release, then start signing with it; old licenses keep verifying while the old public key stays in `keys/`.

## Minting a license

```bash
node scripts/sign-license.js payload.json ~/depot-license-keys/ptech-license-private.pem > license.json
```

The signer validates a version 2 payload field by field and fills in `kid`. The fleet tooling in the private `depot-fleet` repository wraps this per customer.
