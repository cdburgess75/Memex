'use strict';
// Compliance evidence package: aggregates the control matrix + attestations,
// runtime probes, audit-log integrity, access review, and release/update posture
// into one structured bundle, and renders a human-readable Markdown document an
// admin can hand to a customer security review, auditor, or cyber-insurer.
const compliance = require('./compliance');
const accessReview = require('./accessReview');
const auditLog = require('./auditLog');

async function build() {
  // Refresh runtime probes best-effort so the package reflects current posture.
  try { await compliance.runProbes(); } catch { /* keep last cached probes */ }
  const [posture, frameworks, updates, access, integrity] = await Promise.all([
    compliance.summary().catch(() => null),
    compliance.profileStatus().catch(() => []),
    compliance.updateStatus().catch(() => null),
    accessReview.build().catch(e => ({ error: e.message, users: [], openLibraries: [], userCount: 0 })),
    auditLog.verify().catch(e => ({ ok: false, error: e.message })),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    version: updates?.app?.version || 'dev',
    git: updates?.app?.git || null,
    posture,
    probes: compliance.probeMeta(),
    frameworks,
    accessReview: access,
    auditIntegrity: integrity,
    updates,
  };
}

const yn = (b) => (b === true ? 'Yes' : b === false ? 'No' : 'Unknown');
const mark = (b) => (b === true ? 'Met' : b === false ? 'Gap' : 'Unknown');
const esc = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n+/g, ' ');

function toMarkdown(b) {
  const lines = [];
  lines.push('# Memex compliance evidence package');
  lines.push('');
  lines.push(`Generated: ${b.generatedAt}`);
  lines.push(`Application version: ${b.version}${b.git && b.git.commit ? ` (commit ${b.git.commit})` : ''}`);
  lines.push('');
  lines.push('> This package is generated from the running system. It is evidence of configured controls, not a certification or an audit opinion.');
  lines.push('');

  // Posture
  if (b.posture) {
    lines.push('## Readiness posture');
    lines.push('');
    lines.push(`Enabled frameworks: ${b.posture.enabledFrameworks}. Controls ready: ${b.posture.ready} of ${b.posture.total}. Overall: ${b.posture.status}.`);
    lines.push('');
  }

  // Frameworks + control matrix
  lines.push('## Control matrix');
  lines.push('');
  for (const f of b.frameworks || []) {
    lines.push(`### ${esc(f.label || f.id)}${f.enabled ? '' : ' (not enabled)'}`);
    if (f.scope) lines.push(`_${esc(f.scope)}_`);
    lines.push('');
    lines.push('| Control | Status | Evidence | Attested by |');
    lines.push('|---|---|---|---|');
    for (const c of f.controls || []) {
      const by = c.attestation && c.attestation.met ? `${esc(c.attestation.by)} @ ${esc(c.attestation.at)}` : '';
      lines.push(`| ${esc(c.label)} | ${mark(c.ready)} | ${esc(c.evidence)} | ${by} |`);
    }
    lines.push('');
  }

  // Probes
  const pr = b.probes && b.probes.results;
  if (pr) {
    lines.push('## Runtime checks');
    lines.push('');
    lines.push(`Last run: ${b.probes.lastRun ? new Date(b.probes.lastRun).toISOString() : 'never'}`);
    lines.push('');
    lines.push('| Check | Status | Detail |');
    lines.push('|---|---|---|');
    for (const [k, v] of Object.entries(pr)) {
      lines.push(`| ${esc(k)} | ${esc(v && v.status)} | ${esc(v && v.detail)} |`);
    }
    lines.push('');
  }

  // Audit-log integrity
  lines.push('## Audit-log integrity');
  lines.push('');
  if (b.auditIntegrity && b.auditIntegrity.ok) {
    lines.push(`Tamper-evident hash chain verified intact: ${b.auditIntegrity.count} chained event(s).`);
  } else if (b.auditIntegrity && b.auditIntegrity.error) {
    lines.push(`Could not verify: ${esc(b.auditIntegrity.error)}`);
  } else {
    lines.push(`Integrity check FAILED at entry ${esc(b.auditIntegrity && b.auditIntegrity.brokenAt)}: ${esc(b.auditIntegrity && b.auditIntegrity.reason)}`);
  }
  lines.push('');

  // Access review
  const ar = b.accessReview || {};
  lines.push('## Access review');
  lines.push('');
  if (ar.error) {
    // Surface the failure the same way the audit-integrity section does, so an
    // empty table is never mistaken for "no users" in a compliance artifact.
    lines.push(`Access review could not be generated: ${esc(ar.error)}. The list below is incomplete and must not be treated as evidence.`);
    lines.push('');
  }
  if (ar.openLibraries && ar.openLibraries.length) lines.push(`Open libraries (any signed-in user): ${ar.openLibraries.map(esc).join(', ')}`);
  lines.push('');
  lines.push('| User | Role | Libraries | Direct shares | Last activity |');
  lines.push('|---|---|---|---|---|');
  for (const u of ar.users || []) {
    lines.push(`| ${esc(u.email)}${u.name ? ` (${esc(u.name)})` : ''} | ${esc(u.role)} | ${esc((u.libraries || []).join(', '))} | ${u.directShares || 0} | ${esc(u.lastActivity || 'never')} |`);
  }
  lines.push('');

  // Update posture
  if (b.updates) {
    lines.push('## Change and update posture');
    lines.push('');
    lines.push(`Update method: ${esc(b.updates.app && b.updates.app.updateMethod)}.`);
    lines.push(`Dependency audit available: ${yn(b.updates.dependencyAudit && b.updates.dependencyAudit.available)} (\`${esc(b.updates.dependencyAudit && b.updates.dependencyAudit.recommendedCommand)}\`).`);
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = { build, toMarkdown };
