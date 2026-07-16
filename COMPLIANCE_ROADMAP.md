# Compliance Roadmap

_Planning document only. This is not legal advice, an audit opinion, or a certification claim._

> **Status note (2026-07-16).** Several Milestone 1 items have shipped (HTTPS, Keycloak SSO, rate
> limiting, trash/restore/purge/versioning, activity logging, access-review export, security headers,
> local backup + verify tooling). The load-bearing gaps that remain are encryption-key custody and
> tested off-box backups (including the Keycloak database), audit coverage of downloads/logins/admin
> actions in the tamper-evident log, and malware scanning. The compliance-readiness pills in the admin
> panel currently overstate readiness from thin config signals; treat this roadmap's gap list as the
> more accurate picture. See **`REMEDIATION_PLAN.md`** for the reconciled, ranked status of every item.

## Goal

Move Memex/FileDepot from a useful internal file store toward an audit-ready business file
platform. The first target should be SOC 2-style readiness because those controls overlap with
HIPAA, CMMC, ISO 27001, and customer security questionnaires.

## Current Position

Already started:

- Authenticated access through Keycloak.
- Admin/contributor/viewer roles.
- Rate limiting.
- File trash, restore, purge, history, and previous-version restore.
- Activity logging for key file actions.
- Configurable local encryption key support.
- Streaming upload path for large files.
- Versioned releases and git tags.
- Dedicated document disk in the dev VM.
- Local backup and non-destructive restore-check tooling.

Major gaps:

- HTTPS and real SSO/MFA are not live yet.
- Production storage still needs dedicated resilient storage.
- Off-box backups are not configured yet.
- No malware scanning, data classification, DLP, or legal hold.
- No immutable/tamper-resistant audit log yet.
- No formal policies, access reviews, vulnerability management, incident response, or evidence binder.

## Milestone 1: Secure Internal File Store

Target outcome: safe enough for internal business use on trusted networks.

- Enable HTTPS for `files.ptechllc.com`.
- Require SSO/MFA through Keycloak or an upstream identity provider.
- Disable plain password/direct-grant login after HTTPS SSO is verified.
- Move document storage to a dedicated large disk, ZFS dataset, NAS, or object storage.
- Enable encryption at rest and document key custody.
- Configure off-box backups and test restore.
- Add malware scanning for uploaded files.
- Add basic security headers and tighter CORS.
- Add admin access review export.

Evidence to retain:

- Architecture diagram.
- Data flow diagram.
- Backup restore test result.
- User/role export.
- Change log and release tags.
- Security configuration screenshots or exports.

## Milestone 2: SOC 2-Style Readiness

Target outcome: credible answers for customer security reviews and a path toward SOC 2 Type I.

- Map controls to SOC 2 Trust Services Criteria: security first, then availability/confidentiality.
- Maintain a risk register.
- Maintain access review records at least quarterly.
- Keep change management records for releases.
- Track vulnerabilities and patch cadence.
- Maintain incident response policy and runbook.
- Maintain vendor inventory, including AI providers and hosting providers.
- Document data retention and deletion policy.
- Add immutable or append-only audit log storage.
- Add automated evidence exports.

Evidence to retain:

- Control matrix.
- Quarterly access review.
- Vulnerability scan reports.
- Incident response tabletop notes.
- Backup/DR test records.
- Vendor/security review files.
- Release/change approval records.

## Milestone 3: Regulated Data Capability

Target outcome: prepare for HIPAA/CMMC-style workloads where data handling rules are stricter.

- Add file classification labels.
- Add legal hold to prevent purge/version deletion.
- Add configurable retention policies by class or folder.
- Add stronger audit trails for view/download/share/export.
- Add external share governance: expiry, revocation, password/MFA, per-link audit.
- Add device/session controls and short-lived sessions.
- Add per-folder ACLs and inheritance.
- Add DLP-style controls for sensitive data patterns.
- Add eDiscovery export for file history, audit events, and retained versions.
- Add AI/data-processing controls: redaction, provider allowlist, audit of AI submissions, and no-AI zones.

Framework notes:

- HIPAA requires administrative, physical, and technical safeguards plus BAAs with relevant vendors.
- CMMC requires evidence of NIST 800-171-aligned practices; access control, audit, configuration, incident response, media protection, and system integrity become especially important.
- ISO 27001 requires a formal ISMS, risk treatment, policies, internal audits, and management review.

## Milestone 4: Audit Package

Target outcome: a repeatable evidence binder that can be shown to customers, auditors, or cyber-insurance reviewers.

- Compliance overview.
- System architecture and data flow diagrams.
- Control matrix.
- Asset inventory.
- User access review evidence.
- Backup and restore evidence.
- Incident response plan.
- Vulnerability management evidence.
- Change management evidence.
- Vendor and subprocessors list.
- Data retention/deletion policy.
- Encryption/key management summary.
- Security testing results.

## Product Backlog

- HTTPS/SSO/MFA cutover.
- Dedicated resilient storage, preferably ZFS or object storage.
- Off-box backups with scheduled restore tests.
- Immutable audit log.
- Malware scanning with ClamAV or equivalent.
- File classification and retention policy engine.
- Legal hold.
- Access review export.
- Vulnerability scanning and dependency alerts.
- Security headers and hardened reverse proxy.
- DLP/sensitive-pattern detection.
- External share governance.
- AI governance controls and evidence.
- Compliance evidence export.
