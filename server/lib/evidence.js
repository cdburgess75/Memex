'use strict';
// Compliance evidence package: aggregates the control matrix + attestations,
// runtime probes, audit-log integrity, access review, and release/update posture
// into one structured bundle, and renders a human-readable Markdown document an
// admin can hand to a customer security review, auditor, or cyber-insurer.
const compliance = require('./compliance');
const accessReview = require('./accessReview');
const auditLog = require('./auditLog');
const settings = require('./settings');

// Who this Depot belongs to and where it runs, for the packet's cover. The brand
// name is what the firm typed into Workspace settings; the license names the
// customer when no brand is set.
async function firmInfo() {
  let name = '';
  try { name = (await settings.getOrEnv('brand_name')) || ''; } catch { /* no brand */ }
  if (!name) { try { name = (await require('./license').status())?.customer || ''; } catch { /* unlicensed */ } }
  let hostname = '';
  try { hostname = String((await settings.getOrEnv('app_url')) || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, ''); } catch { /* unset */ }
  return { name: name || 'Your firm', hostname };
}

// The settings the Safeguards packet quotes as numbers, read once.
async function settingsSnapshot() {
  const get = async (k) => { try { return await settings.getOrEnv(k); } catch { return null; } };
  const getDb = async (k) => { try { return await settings.get(k); } catch { return null; } };
  const linkCap = Number.parseInt((await get('share_link_max_days')) || '', 10);
  const trashRaw = await get('trash_retention_days');
  const backupRun = await getDb('backup_last_run');
  return {
    mfaRequired: String((await getDb('mfa_required')) || '').toLowerCase() === 'true',
    ms365SignIn: compliance.boolValue(await get('login_ms365_enabled')),
    shareLinkMaxDays: Number.isFinite(linkCap) && linkCap > 0 ? linkCap : null,
    trashRetentionDays: trashRaw == null || trashRaw === '' ? 30 : Number(trashRaw),
    encryptionAtRest: !!(await get('storage_encryption_key')),
    https: /^https:/i.test((await get('app_url')) || ''),
    backupLastRun: backupRun ? new Date(Number(backupRun)).toISOString() : null,
  };
}

async function build() {
  // Refresh runtime probes best-effort so the package reflects current posture.
  try { await compliance.runProbes(); } catch { /* keep last cached probes */ }
  const [posture, frameworks, updates, access, integrity, firm, snapshot] = await Promise.all([
    compliance.summary().catch(() => null),
    compliance.profileStatus().catch(() => []),
    compliance.updateStatus().catch(() => null),
    accessReview.build().catch(e => ({ error: e.message, users: [], openLibraries: [], userCount: 0 })),
    auditLog.verify().catch(e => ({ ok: false, error: e.message })),
    firmInfo().catch(() => ({ name: 'Your firm', hostname: '' })),
    settingsSnapshot().catch(() => null),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    version: updates?.app?.version || 'dev',
    git: updates?.app?.git || null,
    firm,
    settings: snapshot,
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
  if (ar.openLibraries && ar.openLibraries.length) lines.push(`Listed to every signed-in user (no file access): ${ar.openLibraries.map(esc).join(', ')}`);
  lines.push('');
  lines.push('Access comes from owning a library, a share of a library or folder (to the person or a group they belong to; shares match only a verified address), or files shared one by one. "Listed in" is the older member list, which only decides who sees a library listed.');
  lines.push('');
  lines.push('| User | Role | Owns | Library access | Folder access | Groups | Listed in | Direct shares | Last activity |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  const list = (a) => esc((a || []).join('; ')) || '—';
  for (const u of ar.users || []) {
    const who = `${esc(u.email)}${u.name ? ` (${esc(u.name)})` : ''}${u.emailVerified === false ? ' — email not verified' : ''}`;
    lines.push(`| ${who} | ${esc(u.role)} | ${list(u.owns)} | ${list(u.libraryAccess)} | ${list(u.folderAccess)} | ${list(u.groups)} | ${list(u.libraries)} | ${u.directShares || 0} | ${esc(u.lastActivity || 'never')} |`);
  }
  lines.push('');
  if (ar.pendingShares && ar.pendingShares.length) {
    lines.push('Shared with addresses that have no verified account (they get this access once they sign in with that address verified):');
    lines.push('');
    for (const p of ar.pendingShares) lines.push(`- ${esc(p.email)}: ${list([...(p.libraryAccess || []), ...(p.folderAccess || [])])}`);
    lines.push('');
  }

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

// ---- The Safeguards packet ----
// One printable HTML file for a tax or accounting firm: a cover, a page of prose
// written to be pasted into their written security plan (IRS Pub 5708 template), the
// Safeguards Rule checklist, who has access, the audit-log check, and the settings
// the prose quotes. No scripts, inline CSS only, so it opens and prints anywhere.

const h = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const longDate = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// The framework the packet is about: Safeguards when it is tracked, else the first
// tracked one, else Safeguards untracked (so the checklist still prints).
function packetFramework(b) {
  const fws = b.frameworks || [];
  return fws.find(f => f.id === 'safeguards' && f.enabled) || fws.find(f => f.enabled) || fws.find(f => f.id === 'safeguards') || fws[0] || { name: 'Compliance', controls: [] };
}

// Section 2: the prose. Each paragraph reads the live state so it stays true.
function wispParagraphs(b, fw) {
  const s = b.settings || {};
  const by = Object.fromEntries((fw.controls || []).map(c => [c.id, c]));
  const met = (id) => by[id]?.ready === true;
  const firm = b.firm?.name || 'The firm';
  const where = b.firm?.hostname ? ` at ${b.firm.hostname}` : '';
  const paras = [];
  paras.push(`${firm} keeps client files in Depot, a file system that runs on the firm's own server${where}. Files never leave that server except when a member of the firm downloads one or deliberately shares it. No outside service holds a copy.`);
  paras.push(s.mfaRequired
    ? 'Every person signs in with their own account and must enter a one-time code as a second step. A password on its own does not open the system.'
    : s.ms365SignIn
      ? `Every person signs in with their own Microsoft 365 account. The second step at sign-in (multi-factor authentication) is enforced by the firm's Microsoft 365 tenant${met('mfa') ? ', which the firm has confirmed' : ' — the firm is to confirm this'}.`
      : 'Every person signs in with their own account. A second step at sign-in (multi-factor authentication) is not yet required; the firm is to turn it on.');
  paras.push(s.encryptionAtRest
    ? `Files are encrypted where they are stored (AES-256-GCM) and ${s.https ? 'in transit (HTTPS)' : 'are to be encrypted in transit once HTTPS is enabled'}.`
    : `Files are ${s.https ? 'encrypted in transit (HTTPS) but ' : ''}not yet encrypted where they are stored; the firm is to turn on encryption at rest.`);
  const ar = b.accessReview || {};
  const admins = (ar.users || []).filter(u => u.role === 'admin').length;
  const n = ar.userCount || (ar.users || []).length || 0;
  paras.push(`Access is by named person. ${n === 1 ? 'One person' : `${n} people`} can sign in, ${plural(admins, 'administrator')}. A person sees only the libraries and folders shared with them; a library is private to its owner until shared. The full list is in section 3 and is reviewed when staff join or leave and at least once a year.`);
  paras.push(`Depot records who viewed, downloaded, uploaded, changed, shared, or deleted each file, and who was given or lost access. The record is hash-chained so a changed or deleted entry is detectable${b.auditIntegrity?.ok && b.auditIntegrity.count ? `; it was verified intact when this packet was produced (${b.auditIntegrity.count.toLocaleString()} entries)` : ''}.`);
  paras.push(s.shareLinkMaxDays
    ? `When a file must go to someone outside the firm, it goes by a link that expires within ${plural(s.shareLinkMaxDays, 'day')} and can carry a password. Links can be cut off at any time, and each use is recorded.`
    : 'When a file must go to someone outside the firm, it goes by a link that can carry an expiry date and a password. The firm is to set a limit on how long a link may live.');
  paras.push(met('backup_restore')
    ? `The server is backed up${s.backupLastRun ? ` (most recently ${longDate(s.backupLastRun)})` : ''}, so client files can be recovered after a hardware failure or an incident.`
    : 'The firm is to put a tested backup of the server in place so client files can be recovered after a hardware failure or an incident.');
  paras.push(Number.isFinite(s.trashRetentionDays) && s.trashRetentionDays > 0
    ? `A deleted file is held in the trash for ${plural(s.trashRetentionDays, 'day')} and then disposed of. Tax returns and workpapers are kept for the periods the IRS and the firm's professional standards require, and deleted after that.`
    : 'Deleted files are to be disposed of on a schedule. Tax returns and workpapers are kept for the periods the IRS and the firm\'s professional standards require, and deleted after that.');
  paras.push(`Depot is kept up to date through signed releases. The version in use when this packet was produced was ${b.version}.`);
  return paras;
}

function toPacketHtml(b) {
  const fw = packetFramework(b);
  const firm = b.firm?.name || 'Your firm';
  const date = longDate(b.generatedAt) || b.generatedAt;
  const controls = fw.controls || [];
  const open = controls.filter(c => c.ready !== true);
  const verdict = !open.length ? 'Ready' : `${open.length} to do`;

  const checklistRows = controls.map(c => {
    const who = c.attestation?.met && c.attestation.by ? `${h(c.attestation.by)}, ${h(longDate(c.attestation.at))}` : '';
    return `<tr><td class="st ${c.ready === true ? 'ok' : 'no'}">${c.ready === true ? 'Met' : 'To do'}</td><td><b>${h(c.label)}</b>${c.why ? `<div class="why">${h(c.why)}</div>` : ''}</td><td>${h(c.evidence)}${c.ready !== true && c.gap ? `<div class="gap">${h(c.gap)}</div>` : ''}</td><td>${who}</td></tr>`;
  }).join('');

  const ar = b.accessReview || {};
  const list = (a) => (a || []).length ? h(a.join('; ')) : '—';
  const accessRows = (ar.users || []).map(u =>
    `<tr><td>${h(u.email)}${u.name ? `<div class="why">${h(u.name)}</div>` : ''}</td><td>${h(u.role)}</td><td>${list(u.owns)}</td><td>${list([...(u.libraryAccess || []), ...(u.folderAccess || [])])}</td><td>${list(u.groups)}</td><td>${h(u.lastActivity ? longDate(u.lastActivity) : 'never')}</td></tr>`
  ).join('');

  const ai = b.auditIntegrity || {};
  const integrity = ai.ok
    ? ai.count ? `The record was checked entry by entry and is intact: ${ai.count.toLocaleString()} chained entries, none altered or missing.` : 'The record has no entries yet; it fills in as people use Depot.'
    : ai.error ? `The record could not be checked: ${h(ai.error)}.` : `The check FAILED at entry ${h(ai.brokenAt)}: ${h(ai.reason)}. Treat the log as altered and investigate.`;

  const s = b.settings || {};
  const yesNo = (v) => (v ? 'Yes' : 'No');
  const snapshot = [
    ['Second step at sign-in required (local accounts)', yesNo(s.mfaRequired)],
    ['Sign-in through Microsoft 365', yesNo(s.ms365SignIn)],
    ['Longest a share link may live', s.shareLinkMaxDays ? plural(s.shareLinkMaxDays, 'day') : 'No limit set'],
    ['Deleted files disposed of after', Number.isFinite(s.trashRetentionDays) && s.trashRetentionDays > 0 ? plural(s.trashRetentionDays, 'day') : 'Never (manual only)'],
    ['Encrypted where stored', yesNo(s.encryptionAtRest)],
    ['Encrypted in transit (HTTPS)', yesNo(s.https)],
    ['Most recent backup', s.backupLastRun ? longDate(s.backupLastRun) : 'None recorded'],
    ['Depot version', b.version + (b.git?.commit ? ` (${b.git.commit})` : '')],
    ['Server', b.firm?.hostname || '—'],
  ].map(([k, v]) => `<tr><td>${h(k)}</td><td>${h(v)}</td></tr>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(firm)} — Safeguards packet — ${h(b.generatedAt.slice(0, 10))}</title>
<style>
  @page { size: letter; margin: 0.9in 0.85in; }
  html { color-scheme: light; }
  body { font: 11.5pt/1.5 Georgia, 'Times New Roman', serif; color: #1a1a1a; margin: 0; background: #fff; }
  main { max-width: 7.2in; margin: 0 auto; padding: 0.6in 0.5in; }
  h1 { font: 700 26pt/1.15 Georgia, serif; margin: 0 0 6pt; }
  h2 { font: 700 15pt/1.25 Georgia, serif; margin: 0 0 10pt; padding-bottom: 4pt; border-bottom: 1.5px solid #1a1a1a; }
  h2 small { font: 600 9pt/1 Helvetica, Arial, sans-serif; letter-spacing: .12em; text-transform: uppercase; color: #666; display: block; margin-bottom: 6pt; }
  p { margin: 0 0 9pt; }
  .cover { min-height: 8.2in; display: flex; flex-direction: column; justify-content: space-between; }
  .cover .kicker { font: 600 10pt/1 Helvetica, Arial, sans-serif; letter-spacing: .14em; text-transform: uppercase; color: #666; margin-bottom: 18pt; }
  .cover .verdict { display: inline-block; margin: 14pt 0 0; padding: 7pt 12pt; border-radius: 6pt; font: 700 12pt Helvetica, Arial, sans-serif; }
  .cover .verdict.ok { background: #e7f3e9; color: #1f5f2a; } .cover .verdict.no { background: #fbeeea; color: #8a2f1e; }
  .cover dl { display: grid; grid-template-columns: 1.6in 1fr; gap: 3pt 12pt; margin: 18pt 0 0; font-size: 10.5pt; }
  .cover dt { color: #666; } .cover dd { margin: 0; }
  .disc { font: 9.5pt/1.45 Helvetica, Arial, sans-serif; color: #555; border-top: 1px solid #ccc; padding-top: 8pt; }
  section { page-break-before: always; break-before: page; }
  table { width: 100%; border-collapse: collapse; font: 9.5pt/1.4 Helvetica, Arial, sans-serif; margin: 6pt 0 10pt; }
  th { text-align: left; font-size: 8pt; letter-spacing: .08em; text-transform: uppercase; color: #666; border-bottom: 1px solid #999; padding: 4pt 6pt 4pt 0; }
  td { padding: 6pt 6pt 6pt 0; border-bottom: 1px solid #e3e3e3; vertical-align: top; }
  tr { page-break-inside: avoid; break-inside: avoid; }
  td.st { font-weight: 700; white-space: nowrap; width: 3.2em; } td.st.ok { color: #1f5f2a; } td.st.no { color: #8a2f1e; }
  .why { color: #666; font-size: 8.5pt; margin-top: 2pt; }
  .gap { margin-top: 3pt; color: #8a2f1e; }
  .note { font: 9.5pt/1.45 Helvetica, Arial, sans-serif; color: #555; margin: 0 0 10pt; }
  @media screen { body { background: #ececec; } main { background: #fff; box-shadow: 0 2px 12px rgba(0,0,0,.12); margin: 24px auto; } }
  @media print { main { padding: 0; box-shadow: none; } .cover { min-height: 8.5in; } }
</style></head>
<body><main>
<div class="cover">
  <div>
    <div class="kicker">FTC Safeguards Rule · Information security packet</div>
    <h1>${h(firm)}</h1>
    <p>How client information is protected in Depot, as of ${h(date)}.</p>
    <span class="verdict ${open.length ? 'no' : 'ok'}">${h(fw.name)}: ${h(verdict)}</span>
    <dl>
      <dt>Prepared</dt><dd>${h(date)}</dd>
      <dt>System</dt><dd>Depot ${h(b.version)}${b.firm?.hostname ? `, ${h(b.firm.hostname)}` : ''}</dd>
      <dt>Where it runs</dt><dd>On the firm's own server</dd>
      <dt>Sections</dt><dd>1 Summary for your written plan · 2 Checklist · 3 Who has access · 4 Audit-log check · 5 Settings</dd>
    </dl>
  </div>
  <p class="disc">Produced by Depot from its own settings and records. It describes this system as it stood on the date above. It is not legal advice, an audit opinion, or a certification; the firm's written information security plan, risk assessment, training, and yearly report remain the firm's own.</p>
</div>

<section>
  <h2><small>Section 1</small>Summary for your written information security plan</h2>
  <p class="note">Paste this into the "Information systems" or "Safeguards" part of your plan (IRS Pub 5708 template). Every sentence reflects this Depot's settings on ${h(date)}; produce a fresh packet when they change.</p>
  ${wispParagraphs(b, fw).map(p => `<p>${h(p)}</p>`).join('\n  ')}
</section>

<section>
  <h2><small>Section 2</small>Safeguards Rule checklist</h2>
  <p class="note">Each line names the part of 16 CFR 314.4 it answers to. "Met" lines Depot can see for itself, or an administrator confirmed; "To do" lines say what to do next.</p>
  <table><thead><tr><th>Status</th><th>Requirement</th><th>What Depot shows</th><th>Confirmed by</th></tr></thead><tbody>${checklistRows}</tbody></table>
</section>

<section>
  <h2><small>Section 3</small>Who has access</h2>
  ${ar.error ? `<p class="note"><b>The access list could not be produced:</b> ${h(ar.error)}. Do not treat the table below as complete.</p>` : ''}
  <p class="note">${(ar.userCount || (ar.users || []).length || 0) === 1 ? 'One person' : `${ar.userCount || (ar.users || []).length || 0} people`} can sign in. Access comes from owning a library, from a library or folder shared with the person or a group they belong to, or from files shared one by one.${ar.openLibraries?.length ? ` Listed to everyone who signs in (no file access): ${h(ar.openLibraries.join(', '))}.` : ''}</p>
  <table><thead><tr><th>Person</th><th>Role</th><th>Owns</th><th>Shared with them</th><th>Groups</th><th>Last active</th></tr></thead><tbody>${accessRows || '<tr><td colspan="6">No one yet.</td></tr>'}</tbody></table>
  ${ar.pendingShares?.length ? `<p class="note">Shared with addresses that have not signed in yet: ${ar.pendingShares.map(p => h(p.email)).join(', ')}.</p>` : ''}
</section>

<section>
  <h2><small>Section 4</small>Audit-log check</h2>
  <p>Depot keeps a record of every view, download, upload, change, share, and deletion, and of every change to who has access. Each entry is chained to the one before it with a cryptographic hash, so an entry that is altered or removed breaks the chain.</p>
  <p>${integrity}</p>
</section>

<section>
  <h2><small>Section 5</small>Settings this packet relies on</h2>
  <table><thead><tr><th>Setting</th><th>Value on ${h(date)}</th></tr></thead><tbody>${snapshot}</tbody></table>
</section>
</main></body></html>`;
}

module.exports = { build, toMarkdown, toPacketHtml };
