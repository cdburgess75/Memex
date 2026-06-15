# Updates And Compliance Design

This document describes the safe path for managing Ubuntu updates, Memex application updates, and compliance readiness from the Admin UI.

It is planning and implementation guidance. It is not legal advice, an audit opinion, or a certification claim.

## Why Updates Need A Runner

Memex runs as a Node application inside Docker. The app container should not have direct root access to the Ubuntu host or unrestricted shell execution. Ubuntu patching and Docker Compose deployment should be handled through a root-owned, allowlisted host runner.

Recommended pattern:

- Create root-owned scripts under `/opt/memex/scripts/`.
- Allow the app to request only those scripts, never arbitrary commands.
- Use a narrow `sudoers` rule for exact script paths.
- Write every request, result, operator, timestamp, and output location to audit evidence.
- Use a lock file so two update jobs cannot run at once.
- Always run a preflight backup/check before application updates.
- Never pass secrets in command arguments.

## Ubuntu Update Flow

Status check:

- OS release and kernel version.
- `apt list --upgradable`.
- Security updates available.
- Reboot-required marker.
- Last successful update timestamp.

Actions:

- Refresh package metadata.
- Apply security updates only.
- Apply all upgrades.
- Reboot only after explicit admin confirmation.

Evidence:

- Package list before update.
- Packages upgraded.
- Reboot requirement.
- Exit code and full log path.
- Admin user who requested the action.

## Memex Application Update Flow

Status check:

- Current `VERSION`.
- Current Git branch and commit.
- Remote upstream commit.
- Docker image/container status.
- Database/container health.

Actions:

- Fetch GitHub.
- Show pending commits.
- Create backup evidence.
- Fast-forward pull only.
- Rebuild app container with Docker Compose.
- Run smoke test.
- Keep rollback instructions tied to previous commit.

Recommended command sequence:

```bash
cd /opt/memex
git fetch --all --prune
git status --short --branch
git log --oneline HEAD..@{u}
./scripts/backup-memex.sh
git pull --ff-only
docker compose up -d --build app
curl -I --max-time 10 http://127.0.0.1:3000
```

## Compliance Page Semantics

The Admin page can enable readiness profiles for:

- SOC 2
- HIPAA
- GDPR
- PCI-DSS
- ISO/IEC 27001
- CMMC

These toggles should mean:

- Show relevant control/gap checklist.
- Include the profile in evidence exports.
- Warn admins about required safeguards before storing regulated data.
- Gate future features such as retention labels, legal hold, AI no-send zones, and export workflows.

These toggles must not mean:

- The organization is certified.
- The software alone satisfies the framework.
- Legal, privacy, or auditor review is optional.

## First Implementation Already Added

- Admin-only `/api/admin/compliance` status endpoint.
- Admin-only compliance profile save endpoint.
- Profile toggles in the Admin UI.
- Update posture cards for app, Ubuntu host, and dependency audit.
- Control/gap summaries based on current Memex capabilities.

## Next Implementation Step

Add a host runner service or root-owned script bridge:

```text
Admin UI -> /api/admin/update-jobs -> queue row -> host runner -> allowlisted script -> evidence log
```

The runner should support dry-run first, then explicit execution.
