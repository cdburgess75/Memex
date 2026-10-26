'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const settings = require('./settings');
const db = require('./db');

const ROOT = path.join(__dirname, '..', '..');

const FRAMEWORKS = [
  {
    // Tax and accounting firms are "financial institutions" under the FTC Safeguards
    // Rule (16 CFR 314). The IRS repeats the same expectations in Pub 4557 and the
    // Pub 5708 written-plan template. Listed first: it is the profile a CPA office
    // turns on, and the one the simple "one light, one download" view is built for.
    id: 'safeguards',
    setting: 'compliance_safeguards_enabled',
    name: 'FTC Safeguards Rule (CPA / tax)',
    scope: 'What the FTC Safeguards Rule and IRS Pub 4557 expect of a tax or accounting firm\'s file system.',
    note: 'Readiness of this Depot only. Your firm still owns its written plan, training, and yearly report.',
    controls: [
      'mfa', 'encryption', 'network_security', 'access_control', 'audit_logging', 'backup_restore',
      'link_governance', 'retention', 'vulnerability_management',
      'wisp', 'qualified_individual', 'risk_assessment', 'incident_response', 'training',
      'provider_oversight', 'annual_report',
    ],
  },
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
    note: 'Depot should avoid cardholder data unless PCI scope is intentionally designed and assessed.',
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
// `why` names the Safeguards Rule clause (16 CFR 314.4) the control answers to, in
// words a firm's office manager can read. `fix` points the client at the place the
// admin can put it right ('setup:mfa', 'settings:<key>', 'backup').
// `attestable` auto controls accept a manual confirmation when the live signal is
// not green — for the things Depot can only see from outside (MFA enforced by a
// Microsoft tenant, say).
const CONTROL_CATALOG = {
  mfa: {
    label: 'A second step at sign-in (MFA)',
    why: '314.4(c)(5): multi-factor authentication for anyone who reaches client information.',
    evidence: 'Sign-in goes through Keycloak; a one-time code can be required for every local account.',
    gap: 'Require an authenticator app for password sign-ins (Settings › Sign-in methods), or confirm your Microsoft 365 tenant requires a second step.',
    fix: 'setup:mfa',
    attestable: true,
  },
  link_governance: {
    label: 'Links to outside people expire',
    why: '314.4(c)(1): limit who can reach client information, and for how long.',
    evidence: 'Share links can carry an expiry date and a password.',
    gap: 'Set the longest a link may live (Settings › Network, limits & calls) and retire links that never expire.',
    fix: 'settings:share_link_max_days',
  },
  wisp: {
    label: 'A written security plan (WISP)',
    why: '314.4: the rule is a written program. IRS Pub 5708 is a free template; the IRS asks about it at PTIN renewal.',
    manual: true,
    evidence: 'Depot cannot see your written plan. Confirm here once it exists, and keep it with your firm records.',
    gap: 'Write the plan (IRS Pub 5708 template), have the owners sign it, and confirm here.',
  },
  qualified_individual: {
    label: 'One person is in charge of security',
    why: '314.4(a): a named Qualified Individual runs the program and reports to the owners.',
    manual: true,
    evidence: 'Depot cannot see who holds this role. Confirm here, naming the person in the note.',
    gap: 'Name the person (an owner, office manager, or your IT provider) and confirm here.',
  },
  risk_assessment: {
    label: 'A written risk assessment',
    why: '314.4(b): a written look at what could go wrong with client information and what you do about it.',
    manual: true,
    evidence: 'Depot cannot see the assessment. Confirm here once it is written.',
    gap: 'Write it (the Pub 5708 template has a section), review it yearly, and confirm here.',
  },
  training: {
    label: 'Staff trained on security this year',
    why: '314.4(e): security awareness training for everyone, refreshed as risks change.',
    manual: true,
    evidence: 'Depot cannot see training records. Confirm here each year with the date in the note.',
    gap: 'Run a short session (phishing, passwords, client data handling), keep the sign-in sheet, and confirm here.',
  },
  provider_oversight: {
    label: 'Service providers are checked',
    why: '314.4(f): pick providers that can protect client information, put it in the contract, and check on them.',
    manual: true,
    evidence: 'Depot cannot see your contracts. Confirm here once your IT and software providers are under written terms.',
    gap: 'Keep a list of providers that touch client data, with a signed agreement for each, and confirm here.',
  },
  annual_report: {
    label: 'A yearly report to the owners',
    why: '314.4(i): the Qualified Individual reports in writing at least once a year.',
    manual: true,
    evidence: 'Depot cannot see the report. The Safeguards packet from this page is written to be attached to it.',
    gap: 'Attach this page\'s packet to a short written report each year, and confirm here with the date.',
  },
  access_control: {
    label: 'Only named people can get in',
    why: '314.4(c)(1): only the people who need client information can reach it, and the list is reviewed.',
    evidence: 'Everyone signs in with their own account and has a role: admin, contributor, or viewer.',
    gap: 'Give each person an account and a role; make at least one person an admin.',
  },
  audit_logging: {
    label: 'A record of who did what',
    why: '314.4(c)(8): a record of who did what with client information, including views and downloads, that cannot be quietly edited.',
    evidence: 'Every view, download, upload, change, share, and deletion is logged, and the log is hash-chained so a changed or deleted entry is detectable.',
    gap: 'The log fills itself in as people use Depot; nothing to set up.',
  },
  encryption: {
    label: 'Files are encrypted where they are stored',
    why: '314.4(c)(3): client information is encrypted where it is stored.',
    fix: 'settings:storage_encryption_key',
    evidence: 'Files on disk are encrypted (AES-256-GCM) with a key only the server holds.',
    gap: 'Set an encryption key (Settings › Storage & backups). Files uploaded before that are not encrypted.',
  },
  backup_restore: {
    label: 'Backups run and can be restored',
    why: '314.4(c)(1) and (h): you can get client information back after a failure or an incident.',
    fix: 'backup',
    evidence: 'Depot can back itself up on a schedule and check that a backup restores.',
    gap: 'Turn on scheduled backups (Settings › Storage & backups), or back up the whole server another way and confirm it here.',
    attestable: true,
  },
  change_management: {
    label: 'Updates are tracked',
    why: '314.4(c)(4): changes to the system are tracked.',
    evidence: 'Depot runs signed, numbered releases; every change is in version history.',
    gap: 'Nothing to set up; Depot keeps its own release record.',
  },
  vendor_ai: {
    label: 'AI/vendor governance',
    evidence: 'AI provider/model is configurable.',
    gap: 'Add vendor inventory, BAA/DPA tracking, AI no-send zones, and prompt/content redaction evidence.',
  },
  incident_response: {
    label: 'A written plan for when something goes wrong',
    why: '314.4(h): a written plan for what to do when something goes wrong, including who calls whom.',
    manual: true,
    evidence: 'Depot cannot see your plan. Confirm here once it is written.',
    gap: 'Write one page: who to call, how to cut off access, who tells clients, the FTC, and the state (Louisiana gives you 60 days to notify people; the FTC wants 30 days for 500 or more). Confirm here.',
  },
  retention: {
    label: 'Deleted files are disposed of on a schedule',
    why: '314.4(c)(6): dispose of client information when it is no longer needed. (Tax returns themselves stay at least three years under IRC 6107; Depot keeps a file until someone deletes it.)',
    evidence: 'Files in the trash are purged after a set number of days.',
    gap: 'Set trash retention to between 1 and 90 days (Settings › Network, limits & calls).',
    fix: 'settings:trash_retention_days',
  },
  export_delete: {
    label: 'Export/delete request workflow',
    manual: true,
    evidence: 'Backup/export and purge primitives exist.',
    gap: 'Add auditable data-subject request workflow with identity verification and completion evidence.',
  },
  vulnerability_management: {
    label: 'The server is scanned and kept patched',
    why: '314.4(d)(2): a yearly penetration test and vulnerability scans every six months, unless the system is watched continuously.',
    manual: true,
    evidence: 'Depot updates itself, and "Run live checks" audits its own components. The twice-yearly scan of the server is your IT provider\'s to run and keep.',
    gap: 'Have your IT provider scan the server every six months and keep the report; confirm here with the date.',
  },
  network_security: {
    label: 'Files are encrypted on the way to you',
    why: '314.4(c)(3): client information is encrypted in transit (HTTPS).',
    fix: 'settings:app_url',
    evidence: 'Baseline security headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy, HSTS on HTTPS) are enforced; CORS, bind address, trust proxy, and production Caddy overlay are configurable.',
    gap: 'Give Depot an https:// address (Settings › Branding & links) so every connection is encrypted.',
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
  access_control: async () => {
    // Don't assert readiness unconditionally — reflect whether role-based access is
    // actually configured (roles assigned, at least one admin), and be explicit that
    // MFA/SSO enforcement and access-review export are not yet evidenced.
    let roles = 0, admins = 0;
    try {
      roles = (await db.queryOne('SELECT count(*)::int AS n FROM user_roles'))?.n || 0;
      admins = (await db.queryOne("SELECT count(*)::int AS n FROM user_roles WHERE role = 'admin'"))?.n || 0;
    } catch { /* table may be absent on a fresh install */ }
    const ready = roles > 0 && admins > 0;
    return {
      ready,
      evidence: ready
        ? `Everyone signs in with their own account; ${roles} ${roles === 1 ? 'person has' : 'people have'} a role, ${admins} of them admin. A second step at sign-in (MFA) is its own item.`
        : 'Everyone must sign in, but nobody has a role yet — give people admin, contributor, or viewer roles.',
    };
  },
  audit_logging: async () => {
    // Green requires the TAMPER-EVIDENT hash chain to be active (that is the control
    // the product advertises) — not merely rows in the plain, editable activity feed.
    let chain = 0, activity = 0;
    try { chain = (await db.queryOne('SELECT count(*)::int AS n FROM document_events WHERE hash IS NOT NULL'))?.n || 0; } catch { /* chain columns may be absent */ }
    try { activity = (await db.queryOne('SELECT count(*)::int AS n FROM activity_log'))?.n || 0; } catch { /* table may be absent */ }
    const ready = chain > 0;
    return {
      ready,
      evidence: ready
        ? `${chain.toLocaleString()} entries in the hash-chained record of views, downloads, changes, shares, deletions, and access changes.`
        : activity > 0
          ? `${activity.toLocaleString()} plain activity entries, but the hash-chained record has none yet — it fills in from the next file action.`
          : 'No activity recorded yet; the record fills in as people use Depot.',
    };
  },
  encryption: async () => {
    const key = await settings.getOrEnv('storage_encryption_key');
    return {
      ready: !!key,
      evidence: key
        ? 'Files on disk are encrypted (AES-256-GCM); the key is set.'
        : 'No encryption key is set — files are stored on disk unencrypted.',
    };
  },
  backup_restore: async () => {
    // Green requires a backup to have actually run successfully — not just that a
    // backup script exists on disk. (A live probe of backup freshness overrides this
    // when available; see evaluateControls.)
    let has = false;
    try { has = fs.readdirSync(path.join(ROOT, 'scripts')).some(f => /backup/i.test(f)); } catch { /* no scripts dir */ }
    let lastOk = false, lastRun = null;
    try {
      const st = JSON.parse((await settings.get('backup_last_status')) || 'null');
      lastOk = !!st?.ok;
      const lr = await settings.get('backup_last_run');
      lastRun = lr ? Number(lr) : null;
    } catch { /* no recorded run */ }
    const ready = has && lastOk;
    return {
      ready,
      evidence: ready
        ? `A backup has completed${lastRun ? ` (most recent ${new Date(lastRun).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })})` : ''}. Keep a note of when you last restored one as a test.`
        : has
          ? 'No backup has completed yet.'
          : 'Backup tooling is missing from this install.',
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
    // Disposal on a schedule: the trash must empty itself, and within a quarter.
    const raw = await settings.getOrEnv('trash_retention_days');
    const days = raw == null || raw === '' ? 30 : Number(raw);   // 30 is the sweeper's default
    const ok = Number.isFinite(days) && days > 0 && days <= 90;
    return {
      ready: ok,
      evidence: ok
        ? `Deleted files are purged after ${days} day${days === 1 ? '' : 's'} in the trash; until then they can be restored.`
        : days === 0
          ? 'The trash never empties itself — deleted files stay on disk until someone purges them.'
          : `Deleted files stay in the trash for ${days} days before purge — longer than the 90 days this profile expects.`,
    };
  },
  mfa: async () => {
    const required = String((await settings.get('mfa_required')) || '').toLowerCase() === 'true';
    const ms365 = boolValue(await settings.getOrEnv('login_ms365_enabled'));
    if (required) {
      return { ready: true, evidence: 'Every local account must enter a one-time code at sign-in (required action in Keycloak).' };
    }
    return {
      ready: false,
      evidence: ms365
        ? 'Sign-in is through Microsoft 365. Depot cannot see whether your Microsoft tenant requires a second step — confirm it below once it does.'
        : 'A one-time code is not required at sign-in — a stolen password is enough to reach client files.',
    };
  },
  link_governance: async () => {
    const raw = await settings.getOrEnv('share_link_max_days');
    const cap = Number.parseInt(raw || '', 10);
    const capSet = Number.isFinite(cap) && cap > 0;
    let forever = 0;
    try {
      forever = (await db.queryOne(
        `SELECT (SELECT count(*) FROM document_share_links WHERE revoked_at IS NULL AND expires_at IS NULL)::int
              + (SELECT count(*) FROM folder_share_links  WHERE revoked_at IS NULL AND expires_at IS NULL)::int AS n`
      ))?.n || 0;
    } catch { /* tables may be absent on a fresh install */ }
    const ready = capSet && forever === 0;
    const liveNote = forever ? `${forever} live link${forever === 1 ? '' : 's'} never expire${forever === 1 ? 's' : ''}` : 'no live link lasts forever';
    return {
      ready,
      evidence: capSet
        ? `Links to outside people expire within ${cap} day${cap === 1 ? '' : 's'}; ${liveNote}.`
        : `No limit is set on how long a link may live; ${liveNote}.`,
    };
  },
  network_security: async () => {
    const url = await settings.getOrEnv('app_url');
    const https = /^https:/i.test(url || '');
    return {
      ready: https,
      evidence: https
        ? 'App URL is configured for HTTPS (config-level only — run the live checks to verify the certificate and reachability). CORS, bind address, and trust-proxy are set.'
        : 'App URL is not set to HTTPS — traffic may be unencrypted in transit.',
    };
  },
};

// compliance_attestations schema: migrations/0004_runtime_ensure_tables.sql.
async function getAttestations() {
  try {
    const rows = await db.query('SELECT * FROM compliance_attestations');
    const map = {};
    for (const r of rows) map[r.control_id] = r;
    return map;
  } catch { return {}; }
}

async function setAttestation(controlId, { met, note }, user) {
  const base = CONTROL_CATALOG[controlId];
  if (!base?.manual && !base?.attestable) throw new Error('Control is not a manual attestation');
  await db.query(
    `INSERT INTO compliance_attestations (control_id, met, note, attested_by, attested_by_email, attested_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (control_id) DO UPDATE
       SET met = EXCLUDED.met, note = EXCLUDED.note,
           attested_by = EXCLUDED.attested_by, attested_by_email = EXCLUDED.attested_by_email, attested_at = NOW()`,
    [controlId, !!met, note || null, user?.id || null, user?.email || null]
  );
}

// ---- Runtime probes (on-demand; slower than config reads, so cached) ----
// Each returns { status: 'ok' | 'gap' | 'unknown', detail }. 'unknown' means the
// probe couldn't run here (e.g. the backup dir isn't mounted into the container),
// in which case the control falls back to its config-based signal.
let _probes = { at: 0, results: null };

function probeHttps(url) {
  return new Promise(resolve => {
    if (!/^https:\/\//i.test(url || '')) return resolve({ status: 'gap', detail: 'app_url is not set to HTTPS.' });
    let done = false;
    const fin = r => { if (!done) { done = true; resolve(r); } };
    try {
      const req = require('https').request(url, { method: 'HEAD', timeout: 4000 }, res => {
        fin({ status: res.statusCode < 500 ? 'ok' : 'gap', detail: `HTTPS reachable with a valid certificate (HTTP ${res.statusCode}).` });
        res.destroy();
      });
      req.on('timeout', () => { req.destroy(); fin({ status: 'unknown', detail: 'HTTPS probe timed out.' }); });
      req.on('error', e => fin({ status: 'gap', detail: `HTTPS probe failed: ${e.message}` }));
      req.end();
    } catch (e) { fin({ status: 'unknown', detail: e.message }); }
  });
}

async function probeNpmAudit() {
  const r = await execFileSafe('npm', ['audit', '--omit=dev', '--json'], { cwd: path.join(ROOT, 'server'), timeout: 25000, maxBuffer: 8 * 1024 * 1024 });
  try {
    const v = JSON.parse(r.value || '{}').metadata?.vulnerabilities || {};
    const crit = v.critical || 0, high = v.high || 0, mod = v.moderate || 0, low = v.low || 0;
    const total = v.total ?? (crit + high + mod + low);
    return { status: (crit + high) === 0 ? 'ok' : 'gap', detail: `${total} known advisories (critical ${crit}, high ${high}, moderate ${mod}, low ${low}).` };
  } catch {
    return { status: 'unknown', detail: 'Dependency audit could not run in this environment.' };
  }
}

function probeBackupFreshness() {
  const dir = process.env.MEMEX_BACKUP_DIR || '/srv/memex-backups';
  try {
    const entries = fs.readdirSync(dir)
      .map(n => { try { return { n, t: fs.statSync(path.join(dir, n)).mtimeMs }; } catch { return null; } })
      .filter(Boolean);
    if (!entries.length) return { status: 'gap', detail: `No backups found in ${dir}.` };
    const newest = entries.sort((a, b) => b.t - a.t)[0];
    const ageDays = (Date.now() - newest.t) / 86400000;
    const age = ageDays < 1 ? 'today' : `${Math.floor(ageDays)}d ago`;
    return { status: ageDays <= 7 ? 'ok' : 'gap', detail: `Most recent backup ${age} (${newest.n}).` };
  } catch {
    return { status: 'unknown', detail: `Backup directory not visible to the app (${dir}).` };
  }
}

async function runProbes() {
  const appUrl = await settings.getOrEnv('app_url');
  const [https, audit, backup] = await Promise.all([probeHttps(appUrl), probeNpmAudit(), probeBackupFreshness()]);
  _probes = { at: Date.now(), results: { https, audit, backup } };
  return _probes;
}

function probeMeta() {
  return { lastRun: _probes.at || null, results: _probes.results };
}

// One evaluated control: live signal for auto controls, attestation for manual ones,
// overridden by a runtime probe result when one is available and definitive.
async function evaluateControls() {
  const [attest, git] = await Promise.all([getAttestations(), gitInfo()]);
  const probes = _probes.results || {};
  const definitive = p => p && p.status !== 'unknown';
  const out = {};
  for (const [id, base] of Object.entries(CONTROL_CATALOG)) {
    if (base.manual) {
      const a = attest[id];
      let ready = !!a?.met;
      let evidence = a?.met ? (a.note ? `Attested: ${a.note}` : 'Attested as met.') : base.evidence;
      // A dependency-audit probe can satisfy vulnerability management on its own.
      if (id === 'vulnerability_management' && definitive(probes.audit)) {
        ready = ready || probes.audit.status === 'ok';
        evidence = probes.audit.detail + (a?.met ? ' · attested' : '');
      }
      out[id] = {
        id, label: base.label, gap: base.gap, why: base.why || '', manual: true, ready, evidence,
        attestation: a ? { met: a.met, note: a.note || '', by: a.attested_by_email || '', at: a.attested_at } : null,
      };
    } else {
      let r = await CHECKS[id]({ git });
      if (id === 'network_security' && definitive(probes.https)) r = { ready: probes.https.status === 'ok', evidence: probes.https.detail };
      if (id === 'backup_restore' && definitive(probes.backup)) r = { ready: probes.backup.status === 'ok', evidence: probes.backup.detail };
      // An attestable control takes a confirmation only when the live signal is not
      // green: the live signal always wins when it is.
      const a = base.attestable ? attest[id] : null;
      if (a?.met && !r.ready) r = { ready: true, evidence: a.note ? `Confirmed: ${a.note}` : 'Confirmed by an admin.' };
      out[id] = {
        id, label: base.label, gap: base.gap, why: base.why || '', fix: base.fix || null, manual: false,
        attestable: !!base.attestable, ready: r.ready, evidence: r.evidence,
        attestation: a ? { met: a.met, note: a.note || '', by: a.attested_by_email || '', at: a.attested_at } : null,
      };
    }
  }
  return out;
}

function boolValue(v) {
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(v || '').toLowerCase());
}

function execFileSafe(cmd, args, opts = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, { cwd: opts.cwd || ROOT, timeout: opts.timeout || 3000, maxBuffer: opts.maxBuffer || 1024 * 1024 }, (error, stdout, stderr) => {
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

module.exports = { FRAMEWORKS, CONTROL_CATALOG, CHECKS, profileStatus, summary, updateStatus, boolValue, setAttestation, getAttestations, runProbes, probeMeta };
