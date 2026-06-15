'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const settings = require('./settings');

const ROOT = path.join(__dirname, '..', '..');

const FRAMEWORKS = [
  {
    id: 'soc2',
    setting: 'compliance_soc2_enabled',
    name: 'SOC 2',
    scope: 'Customer trust, security reviews, availability, confidentiality, privacy, and change evidence.',
    note: 'Readiness profile only. A SOC 2 report still requires a CPA examination.',
    controls: ['access_control', 'audit_logging', 'backup_restore', 'change_management', 'vendor_ai', 'incident_response'],
  },
  {
    id: 'hipaa',
    setting: 'compliance_hipaa_enabled',
    name: 'HIPAA',
    scope: 'Administrative, physical, and technical safeguards for ePHI handling.',
    note: 'Do not store PHI until BAAs, policies, access review, and audit/export controls are in place.',
    controls: ['access_control', 'audit_logging', 'encryption', 'backup_restore', 'retention', 'vendor_ai'],
  },
  {
    id: 'gdpr',
    setting: 'compliance_gdpr_enabled',
    name: 'GDPR',
    scope: 'Personal-data handling, deletion/erasure workflows, retention, and processor evidence.',
    note: 'This profile helps track readiness for data-subject requests; it is not legal advice.',
    controls: ['access_control', 'audit_logging', 'retention', 'export_delete', 'vendor_ai'],
  },
  {
    id: 'pci_dss',
    setting: 'compliance_pci_dss_enabled',
    name: 'PCI-DSS',
    scope: 'Cardholder-data security posture for environments that process, store, or transmit payment data.',
    note: 'Memex should avoid cardholder data unless PCI scope is intentionally designed and assessed.',
    controls: ['access_control', 'audit_logging', 'encryption', 'vulnerability_management', 'network_security'],
  },
  {
    id: 'iso27001',
    setting: 'compliance_iso27001_enabled',
    name: 'ISO/IEC 27001',
    scope: 'ISMS evidence: risk treatment, controls, policies, internal audit, and management review.',
    note: 'Product controls can support an ISMS, but certification is organization-wide.',
    controls: ['risk_register', 'access_control', 'audit_logging', 'backup_restore', 'change_management', 'incident_response'],
  },
  {
    id: 'cmmc',
    setting: 'compliance_cmmc_enabled',
    name: 'CMMC',
    scope: 'DIB cybersecurity posture for FCI/CUI handling aligned to FAR and NIST requirements.',
    note: 'Do not store CUI until scoping, SSP, SPRS/eMASS evidence, and required assessments are ready.',
    controls: ['access_control', 'audit_logging', 'encryption', 'retention', 'vulnerability_management', 'network_security'],
  },
];

const CONTROL_CATALOG = {
  access_control: {
    label: 'Access control',
    ready: true,
    evidence: 'Keycloak authentication with admin/contributor/viewer roles.',
    gap: 'Add SSO/MFA enforcement and scheduled access review export.',
  },
  audit_logging: {
    label: 'Audit logging',
    ready: true,
    evidence: 'Activity log, file history, version history, share events, and admin-only history views.',
    gap: 'Add immutable or append-only audit export.',
  },
  encryption: {
    label: 'Encryption at rest',
    ready: null,
    evidence: 'Local AES-256-GCM encryption is configurable for new uploads.',
    gap: 'Enable key custody, rotation evidence, and storage-provider encryption verification.',
  },
  backup_restore: {
    label: 'Backup and restore evidence',
    ready: true,
    evidence: 'Local backup and verify scripts exist under scripts/.',
    gap: 'Schedule off-box backups and retain restore-test evidence.',
  },
  change_management: {
    label: 'Change management',
    ready: true,
    evidence: 'Git history, version file, tags, and Docker rebuild/deploy flow.',
    gap: 'Add release approval and rollback evidence.',
  },
  vendor_ai: {
    label: 'AI/vendor governance',
    ready: false,
    evidence: 'AI provider/model is configurable.',
    gap: 'Add vendor inventory, BAA/DPA tracking, AI no-send zones, and prompt/content redaction evidence.',
  },
  incident_response: {
    label: 'Incident response',
    ready: false,
    evidence: 'No formal incident runbook is tracked in app yet.',
    gap: 'Add incident response policy, tabletop records, and breach/escalation checklist.',
  },
  retention: {
    label: 'Retention and deletion',
    ready: null,
    evidence: 'Trash retention days are configurable and files can be restored/purged.',
    gap: 'Add data-class retention policies, legal hold, and erasure request tracking.',
  },
  export_delete: {
    label: 'Export/delete request workflow',
    ready: false,
    evidence: 'Backup/export and purge primitives exist.',
    gap: 'Add auditable data-subject request workflow with identity verification and completion evidence.',
  },
  vulnerability_management: {
    label: 'Vulnerability management',
    ready: false,
    evidence: 'Dependency tests exist, but no scheduled vulnerability evidence is retained in-app.',
    gap: 'Add OS/package/dependency scan status, patch cadence, and exception tracking.',
  },
  network_security: {
    label: 'Network security',
    ready: null,
    evidence: 'CORS, bind address, trust proxy, and production Caddy overlay are configurable.',
    gap: 'Enable HTTPS, security headers, MFA/SSO, and hardened reverse proxy evidence.',
  },
  risk_register: {
    label: 'Risk register',
    ready: false,
    evidence: 'Compliance roadmap exists.',
    gap: 'Add risk register, owners, treatment status, and review cadence.',
  },
};

function boolValue(v) {
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(v || '').toLowerCase());
}

function execFileSafe(cmd, args, opts = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, { cwd: ROOT, timeout: opts.timeout || 3000 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        value: (stdout || '').trim(),
        error: error ? ((stderr || error.message || '').trim()) : null,
      });
    });
  });
}

function readVersion() {
  try { return fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim() || 'dev'; }
  catch { return 'dev'; }
}

async function gitInfo() {
  const [commit, branch] = await Promise.all([
    execFileSafe('git', ['rev-parse', '--short', 'HEAD']),
    execFileSafe('git', ['branch', '--show-current']),
  ]);
  return {
    commit: commit.ok ? commit.value : null,
    branch: branch.ok ? branch.value : null,
    available: commit.ok || branch.ok,
  };
}

async function packageAuditAvailable() {
  return fs.existsSync(path.join(ROOT, 'server', 'package-lock.json'));
}

async function profileStatus() {
  const items = [];
  for (const f of FRAMEWORKS) {
    const enabled = boolValue(await settings.getOrEnv(f.setting));
    const controls = f.controls.map(id => ({ id, ...CONTROL_CATALOG[id] }));
    items.push({ ...f, enabled, controls });
  }
  return items;
}

async function updateStatus() {
  const git = await gitInfo();
  return {
    app: {
      version: readVersion(),
      git,
      updateMethod: 'GitHub pull + Docker Compose rebuild',
      safeRunnerRequired: true,
    },
    ubuntu: {
      supportedFromApp: false,
      recommendedMethod: 'Root-owned, allowlisted host updater script invoked by a narrow sudoers rule',
      reason: 'The Node app runs inside a container and should not have direct root apt privileges on the Ubuntu host.',
    },
    dependencyAudit: {
      available: await packageAuditAvailable(),
      recommendedCommand: 'cd server && npm audit --omit=dev',
    },
  };
}

module.exports = { FRAMEWORKS, CONTROL_CATALOG, profileStatus, updateStatus, boolValue };
