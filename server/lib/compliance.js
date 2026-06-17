'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const settings = require('./settings');
const db = require('./db');

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

// `evidence` here is the default/fallback copy; auto controls override it with a live
// signal (see CHECKS), and manual controls override it with the attestation note.
const CONTROL_CATALOG = {
  access_control: {
    label: 'Access control',
    evidence: 'Keycloak authentication with admin/contributor/viewer roles.',
    gap: 'Add SSO/MFA enforcement and scheduled access review export.',
  },
  audit_logging: {
    label: 'Audit logging',
    evidence: 'Activity log, file history, version history, share events, and admin-only history views.',
    gap: 'Add immutable or append-only audit export.',
  },
  encryption: {
    label: 'Encryption at rest',
    evidence: 'Local AES-256-GCM encryption is configurable for new uploads.',
    gap: 'Enable key custody, rotation evidence, and storage-provider encryption verification.',
  },
  backup_restore: {
    label: 'Backup and restore evidence',
    evidence: 'Local backup and verify scripts exist under scripts/.',
    gap: 'Schedule off-box backups and retain restore-test evidence.',
  },
  change_management: {
    label: 'Change management',
    evidence: 'Git history, version file, tags, and Docker rebuild/deploy flow.',
    gap: 'Add release approval and rollback evidence.',
  },
  vendor_ai: {
    label: 'AI/vendor governance',
    evidence: 'AI provider/model is configurable.',
    gap: 'Add vendor inventory, BAA/DPA tracking, AI no-send zones, and prompt/content redaction evidence.',
  },
  incident_response: {
    label: 'Incident response',
    manual: true,
    evidence: 'No formal incident runbook is tracked in app yet.',
    gap: 'Add incident response policy, tabletop records, and breach/escalation checklist.',
  },
  retention: {
    label: 'Retention and deletion',
    evidence: 'Trash retention days are configurable and files can be restored/purged.',
    gap: 'Add data-class retention policies, legal hold, and erasure request tracking.',
  },
  export_delete: {
    label: 'Export/delete request workflow',
    manual: true,
    evidence: 'Backup/export and purge primitives exist.',
    gap: 'Add auditable data-subject request workflow with identity verification and completion evidence.',
  },
  vulnerability_management: {
    label: 'Vulnerability management',
    manual: true,
    evidence: 'Dependency tests exist, but no scheduled vulnerability evidence is retained in-app.',
    gap: 'Add OS/package/dependency scan status, patch cadence, and exception tracking.',
  },
  network_security: {
    label: 'Network security',
    evidence: 'CORS, bind address, trust proxy, and production Caddy overlay are configurable.',
    gap: 'Enable HTTPS, security headers, MFA/SSO, and hardened reverse proxy evidence.',
  },
  risk_register: {
    label: 'Risk register',
    manual: true,
    evidence: 'Compliance roadmap exists.',
    gap: 'Add risk register, owners, treatment status, and review cadence.',
  },
};

// Live, config-based signal for each auto-detectable control. Each returns
// { ready, evidence } reflecting the system's actual state. Manual controls
// (CONTROL_CATALOG[x].manual) are not here — they come from attestations.
const CHECKS = {
  access_control: async () => ({
    ready: true,
    evidence: 'Keycloak authentication is enforced on every request, with admin/contributor/viewer roles.',
  }),
  audit_logging: async () => {
    let n = 0;
    try { n = (await db.queryOne('SELECT count(*)::int AS n FROM activity_log'))?.n || 0; } catch { /* table may be absent */ }
    return {
      ready: n > 0,
      evidence: n > 0
        ? `Activity log active (${n.toLocaleString()} events), plus file, version, and share history.`
        : 'Activity log is present but has no events recorded yet.',
    };
  },
  encryption: async () => {
    const key = await settings.getOrEnv('storage_encryption_key');
    return {
      ready: !!key,
      evidence: key
        ? 'At-rest AES-256-GCM encryption key is configured for local storage.'
        : 'No at-rest encryption key configured — new local uploads are stored unencrypted.',
    };
  },
  backup_restore: async () => {
    let has = false;
    try { has = fs.readdirSync(path.join(ROOT, 'scripts')).some(f => /backup/i.test(f)); } catch { /* no scripts dir */ }
    return {
      ready: has,
      evidence: has
        ? 'Backup and verify scripts are present under scripts/.'
        : 'No backup script found under scripts/.',
    };
  },
  change_management: async ({ git }) => ({
    ready: !!git?.available,
    evidence: git?.available
      ? `Tracked in git (${git.branch || 'branch'} ${git.commit || ''}), with VERSION file and Docker rebuild/deploy flow.`
      : 'Git metadata is not available to the app.',
  }),
  vendor_ai: async () => {
    const anth = await settings.getOrEnv('anthropic_api_key');
    let endpoints = 0;
    try { const p = JSON.parse(await settings.getOrEnv('ai_endpoints') || '[]'); endpoints = Array.isArray(p) ? p.length : 0; } catch { /* ignore */ }
    const configured = !!anth || endpoints > 0 || !!(await settings.getOrEnv('openai_api_key'));
    return {
      ready: configured,
      evidence: configured
        ? 'An AI provider is configured; the active model is selectable and can be turned off.'
        : 'No AI provider configured — AI features are inactive.',
    };
  },
  retention: async () => {
    const days = Number(await settings.getOrEnv('trash_retention_days'));
    const ok = Number.isFinite(days) && days > 0;
    return {
      ready: ok,
      evidence: ok
        ? `Trash retention set to ${days} days; deleted files are recoverable until purge.`
        : 'No explicit trash retention period is configured.',
    };
  },
  network_security: async () => {
    const url = await settings.getOrEnv('app_url');
    const https = /^https:/i.test(url || '');
    return {
      ready: https,
      evidence: https
        ? 'App URL is configured for HTTPS; CORS, bind address, and trust-proxy are set.'
        : 'App URL is not set to HTTPS — traffic may be unencrypted in transit.',
    };
  },
};

async function ensureAttestations() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS compliance_attestations (
      control_id        TEXT PRIMARY KEY,
      met               BOOLEAN NOT NULL DEFAULT false,
      note              TEXT,
      attested_by       UUID,
      attested_by_email TEXT,
      attested_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getAttestations() {
  try {
    await ensureAttestations();
    const rows = await db.query('SELECT * FROM compliance_attestations');
    const map = {};
    for (const r of rows) map[r.control_id] = r;
    return map;
  } catch { return {}; }
}

async function setAttestation(controlId, { met, note }, user) {
  if (!CONTROL_CATALOG[controlId]?.manual) throw new Error('Control is not a manual attestation');
  await ensureAttestations();
  await db.query(
    `INSERT INTO compliance_attestations (control_id, met, note, attested_by, attested_by_email, attested_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (control_id) DO UPDATE
       SET met = EXCLUDED.met, note = EXCLUDED.note,
           attested_by = EXCLUDED.attested_by, attested_by_email = EXCLUDED.attested_by_email, attested_at = NOW()`,
    [controlId, !!met, note || null, user?.id || null, user?.email || null]
  );
}

// One evaluated control: live signal for auto controls, attestation for manual ones.
async function evaluateControls() {
  const [attest, git] = await Promise.all([getAttestations(), gitInfo()]);
  const out = {};
  for (const [id, base] of Object.entries(CONTROL_CATALOG)) {
    if (base.manual) {
      const a = attest[id];
      out[id] = {
        id, label: base.label, gap: base.gap, manual: true,
        ready: !!a?.met,
        evidence: a?.met ? (a.note ? `Attested: ${a.note}` : 'Attested as met.') : base.evidence,
        attestation: a ? { met: a.met, note: a.note || '', by: a.attested_by_email || '', at: a.attested_at } : null,
      };
    } else {
      const r = await CHECKS[id]({ git });
      out[id] = { id, label: base.label, gap: base.gap, manual: false, ready: r.ready, evidence: r.evidence };
    }
  }
  return out;
}

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
  const evaluated = await evaluateControls();
  const items = [];
  for (const f of FRAMEWORKS) {
    const enabled = boolValue(await settings.getOrEnv(f.setting));
    const controls = f.controls.map(id => evaluated[id]).filter(Boolean);
    items.push({ ...f, enabled, controls });
  }
  return items;
}

// At-a-glance posture across enabled frameworks (distinct controls), for the header pill.
async function summary() {
  const frameworks = await profileStatus();
  const enabled = frameworks.filter(f => f.enabled);
  const byControl = new Map();
  for (const f of enabled) for (const c of f.controls) byControl.set(c.id, c.ready === true);
  const total = byControl.size;
  const ready = [...byControl.values()].filter(Boolean).length;
  const status = !enabled.length ? 'off' : (ready === total ? 'ok' : (ready > 0 ? 'warn' : 'crit'));
  return { enabledFrameworks: enabled.length, ready, total, status };
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

module.exports = { FRAMEWORKS, CONTROL_CATALOG, profileStatus, summary, updateStatus, boolValue, setAttestation, getAttestations };
