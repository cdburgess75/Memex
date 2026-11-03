'use strict';
// Compliance evidence package: aggregates the control matrix + attestations,
// runtime probes, audit-log integrity, access review, and release/update posture
// into one structured bundle, and renders a human-readable Markdown document an
// admin can hand to a customer security review, auditor, or cyber-insurer.
const compliance = require('./compliance');
const accessReview = require('./accessReview');
const auditLog = require('./auditLog');
const settings = require('./settings');

// Who this Depot belongs to and where it runs, for the report's cover. The brand
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

// The settings the reports quote as numbers, read once.
async function settingsSnapshot() {
  const get = async (k) => { try { return await settings.getOrEnv(k); } catch { return null; } };
  const getDb = async (k) => { try { return await settings.get(k); } catch { return null; } };
  const linkCap = Number.parseInt((await get('share_link_max_days')) || '', 10);
  const trashRaw = await get('trash_retention_days');
  const backupRun = await getDb('backup_last_run');
  const sessionRaw = Number(await getDb('login_session_hours'));
  return {
    sessionHours: Number.isFinite(sessionRaw) && sessionRaw > 0 ? sessionRaw : null,
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
  const [posture, frameworks, updates, access, integrity, firm, snapshot, retention] = await Promise.all([
    compliance.summary().catch(() => null),
    compliance.profileStatus().catch(() => []),
    compliance.updateStatus().catch(() => null),
    accessReview.build().catch(e => ({ error: e.message, users: [], openLibraries: [], userCount: 0 })),
    auditLog.verify().catch(e => ({ ok: false, error: e.message })),
    firmInfo().catch(() => ({ name: 'Your firm', hostname: '' })),
    settingsSnapshot().catch(() => null),
    retentionSnapshot().catch(() => ({ libraries: [], holds: [], released: [] })),
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
    retention,
  };
}

// Each library's retention policy and every open legal hold (lib/retention.js), for the
// report's "Retention and legal holds" section: what is kept how long, and what nothing
// may delete right now, with who placed each hold, when, and why.
async function retentionSnapshot() {
  const retention = require('./retention');
  const [libraries, holds, released] = await Promise.all([retention.policies(), retention.activeHolds(), retention.holdHistory({ limit: 20 })]);
  return { libraries, holds, released };
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
  if (ar.mfaError) lines.push(`Second step at sign-in could not be checked: ${esc(ar.mfaError)}.`);
  lines.push('');
  lines.push('| User | Role | Second step | Owns | Library access | Folder access | Groups | Listed in | Direct shares | Last activity |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  const list = (a) => esc((a || []).join('; ')) || '—';
  for (const u of ar.users || []) {
    const who = `${esc(u.email)}${u.name ? ` (${esc(u.name)})` : ''}${u.emailVerified === false ? ' — email not verified' : ''}`;
    lines.push(`| ${who} | ${esc(u.role)} | ${esc(accessReview.mfaWord(u.mfa))} | ${list(u.owns)} | ${list(u.libraryAccess)} | ${list(u.folderAccess)} | ${list(u.groups)} | ${list(u.libraries)} | ${u.directShares || 0} | ${esc(u.lastActivity || 'never')} |`);
  }
  lines.push('');
  if (ar.pendingShares && ar.pendingShares.length) {
    lines.push('Shared with addresses that have no verified account (they get this access once they sign in with that address verified):');
    lines.push('');
    for (const p of ar.pendingShares) lines.push(`- ${esc(p.email)}: ${list([...(p.libraryAccess || []), ...(p.folderAccess || [])])}`);
    lines.push('');
  }

  // Retention and legal holds
  const rt = b.retention || {};
  lines.push('## Retention and legal holds');
  lines.push('');
  lines.push('| Library | Kept at least | Disposed of after | Set by |');
  lines.push('|---|---|---|---|');
  for (const l of rt.libraries || []) {
    const who = l.set_by ? `${esc(l.set_by)} @ ${esc(l.set_at)}` : '';
    lines.push(`| ${esc(l.name)}${l.personal ? ' (personal)' : ''}${l.archived ? ' (put away)' : ''} | ${l.min_years ? `${l.min_years} year(s)` : '—'} | ${l.dispose_years ? `${l.dispose_years} year(s) without changes` : '—'} | ${who} |`);
  }
  lines.push('');
  if ((rt.holds || []).length) {
    lines.push('| Legal hold on | Since | Placed by | Reason |');
    lines.push('|---|---|---|---|');
    for (const hd of rt.holds) lines.push(`| ${esc(hd.where)} | ${esc(hd.placed_at)} | ${esc(hd.placed_by || '')} | ${esc(hd.reason)} |`);
  } else {
    lines.push('No legal hold is in place.');
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

// ---- The report, one framework at a time ----
// One printable HTML file per framework: a cover, a page of prose written to be pasted
// into the organization's own plan or policy, the framework's checklist with its
// citations, who has access, the audit-log check, and the settings the prose quotes.
// No scripts, inline CSS only, so it opens and prints anywhere. The Safeguards one is
// the "packet" a CPA office attaches to its written plan (IRS Pub 5708).

const h = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const longDate = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// The framework a report is about: the one asked for, else Safeguards when it is
// tracked, else the first tracked one, else Safeguards untracked (so the checklist
// still prints).
function reportFramework(b, frameworkId) {
  const fws = b.frameworks || [];
  if (frameworkId) return fws.find(f => f.id === frameworkId) || null;
  return fws.find(f => f.id === 'safeguards' && f.enabled) || fws.find(f => f.enabled) || fws.find(f => f.id === 'safeguards') || fws[0] || { id: 'safeguards', name: 'Compliance', controls: [] };
}

// What every prose builder reads: the live settings, who is in, and the record.
function facts(b, fw) {
  const s = b.settings || {};
  const by = Object.fromEntries((fw.controls || []).map(c => [c.id, c]));
  const ar = b.accessReview || {};
  return {
    s, by, met: (id) => by[id]?.ready === true,
    firm: b.firm?.name || 'The organization',
    where: b.firm?.hostname ? ` at ${b.firm.hostname}` : '',
    people: ar.userCount || (ar.users || []).length || 0,
    admins: (ar.users || []).filter(u => u.role === 'admin').length,
    chain: b.auditIntegrity?.ok && b.auditIntegrity.count ? `; it was verified intact when this report was produced (${b.auditIntegrity.count.toLocaleString()} entries)` : '',
  };
}
// Sentences several frameworks share, each true to the live settings.
const line = {
  signIn: (f, what) => f.s.mfaRequired
    ? `Every person signs in with their own account and must enter a one-time code as a second step. A password on its own does not open the system.`
    : f.s.ms365SignIn
      ? `Every person signs in with their own Microsoft 365 account. The second step at sign-in (multi-factor authentication) is enforced by the ${what}'s Microsoft 365 tenant${f.met('mfa') ? `, which the ${what} has confirmed` : ` — the ${what} is to confirm this`}.`
      : `Every person signs in with their own account. A second step at sign-in (multi-factor authentication) is not yet required; the ${what} is to turn it on.`,
  encrypted: (f, what) => f.s.encryptionAtRest
    ? `Files are encrypted where they are stored (AES-256-GCM) and ${f.s.https ? 'in transit (HTTPS)' : 'are to be encrypted in transit once HTTPS is enabled'}.`
    : `Files are ${f.s.https ? 'encrypted in transit (HTTPS) but ' : ''}not yet encrypted where they are stored; the ${what} is to turn on encryption at rest.`,
  access: (f) => `Access is by named person. ${f.people === 1 ? 'One person' : `${f.people} people`} can sign in, ${plural(f.admins, 'administrator')}. A person sees only the libraries and folders shared with them; a library is private to its owner until shared. The full list is in section 3 and is reviewed when staff join or leave and at least once a year.`,
  record: (f) => `Depot records who viewed, downloaded, uploaded, changed, shared, or deleted each file, and who was given or lost access. The record is hash-chained so a changed or deleted entry is detectable${f.chain}.`,
  links: (f, what) => f.s.shareLinkMaxDays
    ? `When a file must go to someone outside the ${what}, it goes by a link that expires within ${plural(f.s.shareLinkMaxDays, 'day')} and can carry a password. Links can be cut off at any time, and each use is recorded.`
    : `When a file must go to someone outside the ${what}, it goes by a link that can carry an expiry date and a password. The ${what} is to set a limit on how long a link may live.`,
  backup: (f, what) => f.met('backup_restore')
    ? `The server is backed up${f.s.backupLastRun ? ` (most recently ${longDate(f.s.backupLastRun)})` : ''}, so files can be recovered after a hardware failure or an incident.`
    : `The ${what} is to put a tested backup of the server in place so files can be recovered after a hardware failure or an incident.`,
  trash: (f) => Number.isFinite(f.s.trashRetentionDays) && f.s.trashRetentionDays > 0
    ? `A deleted file is held in the trash for ${plural(f.s.trashRetentionDays, 'day')} and then disposed of.`
    : 'Deleted files are to be disposed of on a schedule.',
  session: (f, what) => f.s.sessionHours
    ? `A sign-in ends on its own after ${plural(f.s.sessionHours, 'hour')}${f.s.sessionHours > 24 ? `; the ${what} is to shorten this to a day or less` : ''}.`
    : `How long a sign-in lasts has not been set; the ${what} is to set it to a day or less.`,
  version: (b) => `Depot is kept up to date through signed releases. The version in use when this report was produced was ${b.version}.`,
};

// Section 1 for the Safeguards packet: written to be pasted into the firm's WISP.
function wispParagraphs(b, fw) {
  const f = facts(b, fw);
  return [
    `${f.firm} keeps client files in Depot, a file system that runs on the firm's own server${f.where}. Files never leave that server except when a member of the firm downloads one or deliberately shares it. No outside service holds a copy.`,
    line.signIn(f, 'firm'),
    line.encrypted(f, 'firm'),
    line.access(f),
    line.record(f),
    line.links(f, 'firm'),
    line.backup(f, 'firm').replace('so files can', 'so client files can'),
    `${line.trash(f)} Tax returns and workpapers are kept for the periods the IRS and the firm's professional standards require, and deleted after that.`,
    line.version(b),
  ];
}
// Section 1 for HIPAA: the technical safeguards, for the organization's security policies.
function hipaaParagraphs(b, fw) {
  const f = facts(b, fw);
  return [
    `${f.firm} keeps patient files in Depot, a file system that runs on the organization's own server${f.where}. Files never leave that server except when a member of staff downloads one or deliberately shares it. No outside service holds a copy.`,
    `${line.signIn(f, 'organization')} Each action in Depot is tied to that one named person.`,
    line.session(f, 'organization'),
    line.encrypted(f, 'organization').replace('(AES-256-GCM)', '(AES-256-GCM, a cipher that also detects a file altered on disk)'),
    line.access(f),
    line.record(f),
    f.met('emergency_access')
      ? 'The organization has a written procedure for reaching patient files in an emergency, when the usual person or sign-in is not available.'
      : 'The organization is to write down how patient files are reached in an emergency, when the usual person or sign-in is not available.',
    line.backup(f, 'organization').replace('so files can', 'so an exact copy of patient files can'),
    'Business associate agreements, the risk analysis, the organization\'s policies, and staff training are kept with the organization\'s own records; they are outside what Depot can show.',
    line.version(b),
  ];
}
// Section 1 for PCI: a statement of scope, for the organization's PCI questionnaire.
function pciScopeParagraphs(b, fw) {
  const f = facts(b, fw);
  return [
    `${f.firm} keeps its files in Depot, a file system that runs on its own server${f.where}. Depot is not used to store, process, or transmit cardholder data: card payments go through the organization's card terminal or payment provider, never through a file kept here. Depot is therefore outside the organization's PCI DSS scope.`,
    f.met('no_card_data')
      ? 'A written rule says card numbers are never typed into or uploaded to Depot, and staff have been told where payments do go.'
      : 'The organization is to write that rule down (card numbers are never typed into or uploaded to Depot) and tell staff where payments do go.',
    f.by.sensitive_data
      ? (f.met('sensitive_data') ? 'Uploaded files are checked for card numbers, so a slip is caught instead of silently bringing Depot into scope.' : 'Depot is to check uploaded files for card numbers, so a slip is caught instead of silently bringing Depot into scope.')
      : 'Should a card number ever slip into a file, the organization removes the file and records the event; the protections below limit the exposure in the meantime.',
    line.signIn(f, 'organization'),
    line.encrypted(f, 'organization'),
    line.access(f),
    line.record(f),
    line.trash(f),
    line.version(b),
  ];
}
// Section 1 for NIST CSF 2.0: the six functions, one short paragraph each.
function nistParagraphs(b, fw) {
  const f = facts(b, fw);
  return [
    `${f.firm} keeps its files in Depot, a file system that runs on its own server${f.where}. This summary follows the six functions of the NIST Cybersecurity Framework 2.0.`,
    `Govern. ${f.met('qualified_individual') ? 'One named person is responsible for security and reports to leadership.' : 'The organization is to name one person responsible for security who reports to leadership.'} ${f.met('provider_oversight') ? 'Outside providers that touch the organization\'s data are under written terms.' : 'Outside providers that touch the organization\'s data are to be put under written terms.'}`,
    `Identify. ${f.met('risk_assessment') ? 'A written risk assessment says what could go wrong with the organization\'s data and what is done about it.' : 'The organization is to write down what could go wrong with its data and what is done about it.'} Section 3 lists who can reach the files.`,
    `Protect. ${line.signIn(f, 'organization')} ${line.encrypted(f, 'organization')}`,
    `Detect. ${line.record(f)}`,
    `Respond. ${f.met('incident_response') ? 'A written plan says who does what when something goes wrong.' : 'The organization is to write a one-page plan saying who does what when something goes wrong.'}`,
    `Recover. ${line.backup(f, 'organization')}`,
    line.version(b),
  ];
}
// Section 1 for any other framework: the shared sentences, read from the live settings.
function genericParagraphs(b, fw) {
  const f = facts(b, fw);
  return [
    `${f.firm} keeps its files in Depot, a file system that runs on its own server${f.where}. Files never leave that server except when a member of staff downloads one or deliberately shares it. No outside service holds a copy.`,
    line.signIn(f, 'organization'),
    line.encrypted(f, 'organization'),
    line.access(f),
    line.record(f),
    line.links(f, 'organization'),
    line.backup(f, 'organization'),
    line.trash(f),
    line.version(b),
  ];
}

// What differs between the reports: the words on the cover, what section 1 is for,
// what the checklist is called, and who the report says it is not.
const REPORT = {
  safeguards: {
    kicker: 'FTC Safeguards Rule · Information security packet',
    lead: 'How client information is protected in Depot',
    prose: wispParagraphs,
    section1: 'Summary for your written information security plan',
    section1Note: 'Paste this into the "Information systems" or "Safeguards" part of your plan (IRS Pub 5708 template). Every sentence reflects this Depot\'s settings on {date}; produce a fresh packet when they change.',
    checklist: 'Safeguards Rule checklist',
    checklistNote: 'Each line names the part of 16 CFR 314.4 it answers to. "Met" lines Depot can see for itself, or an administrator confirmed; "To do" lines say what to do next.',
    disclaimer: 'It is not legal advice, an audit opinion, or a certification; the firm\'s written information security plan, risk assessment, training, and yearly report remain the firm\'s own.',
    who: 'firm', what: 'packet',
  },
  hipaa: {
    kicker: 'HIPAA Security Rule · Technical safeguards report',
    lead: 'How patient files are protected in Depot',
    prose: hipaaParagraphs,
    section1: 'Summary for your security policies',
    section1Note: 'Paste this into the part of your policies that describes the systems holding patient files. Every sentence reflects this Depot\'s settings on {date}; produce a fresh report when they change.',
    checklist: 'Technical safeguards checklist (45 CFR 164.312)',
    checklistNote: 'Each line names the clause it answers to. "Met" lines Depot can see for itself, or an administrator confirmed; "To do" lines say what to do next.',
    disclaimer: 'HIPAA certifies organizations, not software. It is not legal advice or a certification; the business associate agreements, risk analysis, policies, and training remain the organization\'s own.',
  },
  pci_dss: {
    kicker: 'PCI DSS · Statement of scope',
    lead: 'Why Depot holds no card data',
    prose: pciScopeParagraphs,
    section1: 'Statement of scope',
    section1Note: 'Attach this to your PCI self-assessment questionnaire as the description of this system. Every sentence reflects this Depot\'s settings on {date}; produce a fresh report when they change.',
    checklist: 'Scope-avoidance checklist',
    checklistNote: 'Each line names the PCI DSS v4.0 requirement it relates to. "Met" lines Depot can see for itself, or an administrator confirmed; "To do" lines say what to do next.',
    disclaimer: 'It is not a PCI DSS assessment or an attestation of compliance. PCI DSS applies to systems that store, process, or transmit cardholder data; the aim of this report is to show that Depot is not one of them.',
  },
  nist_csf: {
    kicker: 'NIST Cybersecurity Framework 2.0 · Profile report',
    lead: 'How Depot answers the six functions',
    prose: nistParagraphs,
    section1: 'Profile summary',
    section1Note: 'Use this as the file-system part of your organization\'s current profile. Every sentence reflects this Depot\'s settings on {date}; produce a fresh report when they change.',
    checklist: 'Framework checklist',
    checklistNote: 'Each line names the function and subcategory it answers to. "Met" lines Depot can see for itself, or an administrator confirmed; "To do" lines say what to do next.',
    disclaimer: 'The framework is a way of organizing a program, not a certification. It is not legal advice; the governance, risk, and planning parts remain the organization\'s own.',
  },
  default: {
    kicker: '{name} · Readiness report',
    lead: 'How files are protected in Depot',
    prose: genericParagraphs,
    section1: 'Summary for your policies',
    section1Note: 'Paste this into the part of your policies that describes this system. Every sentence reflects this Depot\'s settings on {date}; produce a fresh report when they change.',
    checklist: 'Checklist',
    checklistNote: 'Each line names the clause it answers to. "Met" lines Depot can see for itself, or an administrator confirmed; "To do" lines say what to do next.',
    disclaimer: 'It is not legal advice, an audit opinion, or a certification; the organization\'s own policies, assessments, and training remain its own.',
  },
};
// Every shape says who it is for and what it calls itself; the packet keeps "firm" and "packet".
for (const r of Object.values(REPORT)) { r.who = r.who || 'organization'; r.what = r.what || 'report'; }
const reportShape = (fw) => REPORT[fw.id] || REPORT.default;

// `shapeId` picks the words (cover, section 1, checklist title) apart from the framework
// whose controls are listed: the packet keeps the Safeguards words even when that
// framework is not tracked here.
function toReportHtml(b, frameworkId, shapeId) {
  const fw = reportFramework(b, frameworkId);
  if (!fw) throw new Error(`No such framework: ${frameworkId}`);
  const R = REPORT[shapeId] || reportShape(fw);
  const firm = b.firm?.name || 'Your firm';
  const date = longDate(b.generatedAt) || b.generatedAt;
  const fill = (t) => String(t).replace('{date}', date).replace('{name}', fw.name);
  const controls = fw.controls || [];
  const open = controls.filter(c => c.ready !== true);
  const verdict = !open.length ? 'Ready' : `${open.length} to do`;
  const short = fw.short || fw.name || fw.label || 'Compliance';

  const checklistRows = controls.map(c => {
    const who = c.attestation?.met && c.attestation.by ? `${h(c.attestation.by)}, ${h(longDate(c.attestation.at))}` : '';
    return `<tr><td class="st ${c.ready === true ? 'ok' : 'no'}">${c.ready === true ? 'Met' : 'To do'}</td><td><b>${h(c.label)}</b>${c.why ? `<div class="why">${h(c.why)}</div>` : ''}</td><td>${h(c.evidence)}${c.ready !== true && c.gap ? `<div class="gap">${h(c.gap)}</div>` : ''}</td><td>${who}</td></tr>`;
  }).join('');

  const ar = b.accessReview || {};
  const list = (a) => (a || []).length ? h(a.join('; ')) : '—';
  const accessRows = (ar.users || []).map(u =>
    `<tr><td>${h(u.email)}${u.name ? `<div class="why">${h(u.name)}</div>` : ''}</td><td>${h(u.role)}</td><td>${h(accessReview.mfaWord(u.mfa))}</td><td>${list(u.owns)}</td><td>${list([...(u.libraryAccess || []), ...(u.folderAccess || [])])}</td><td>${list(u.groups)}</td><td>${h(u.lastActivity ? longDate(u.lastActivity) : 'never')}</td></tr>`
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
    ['How long a sign-in lasts', s.sessionHours ? plural(s.sessionHours, 'hour') : 'Not set here'],
    ['Longest a share link may live', s.shareLinkMaxDays ? plural(s.shareLinkMaxDays, 'day') : 'No limit set'],
    ['Deleted files disposed of after', Number.isFinite(s.trashRetentionDays) && s.trashRetentionDays > 0 ? plural(s.trashRetentionDays, 'day') : 'Never (manual only)'],
    ['Encrypted where stored', yesNo(s.encryptionAtRest)],
    ['Encrypted in transit (HTTPS)', yesNo(s.https)],
    ['Most recent backup', s.backupLastRun ? longDate(s.backupLastRun) : 'None recorded'],
    ['Depot version', b.version + (b.git?.commit ? ` (${b.git.commit})` : '')],
    ['Server', b.firm?.hostname || '—'],
  ].map(([k, v]) => `<tr><td>${h(k)}</td><td>${h(v)}</td></tr>`).join('');

  const rt = b.retention || { libraries: [], holds: [], released: [] };
  const retentionRows = (rt.libraries || []).map(l =>
    `<tr><td>${h(l.name)}${l.personal ? '<div class="why">Personal library</div>' : ''}${l.archived ? '<div class="why">Put away</div>' : ''}</td><td>${l.min_years ? h(plural(l.min_years, 'year')) : '—'}</td><td>${l.dispose_years ? `${h(plural(l.dispose_years, 'year'))} without changes` : '—'}</td><td>${l.set_by ? `${h(l.set_by)}, ${h(longDate(l.set_at))}` : '—'}</td></tr>`
  ).join('');
  const holdRows = (rt.holds || []).map(hd =>
    `<tr><td>${h(hd.where)}</td><td>${h(longDate(hd.placed_at))}</td><td>${h(hd.placed_by || '')}</td><td>${h(hd.reason)}</td></tr>`).join('');
  const releasedRows = (rt.released || []).slice(0, 10).map(hd =>
    `<tr><td>${h(hd.where)}</td><td>${h(longDate(hd.placed_at))}, ${h(hd.placed_by || '')}: ${h(hd.reason)}</td><td>${h(longDate(hd.released_at))}, ${h(hd.released_by || '')}</td><td>${h(hd.release_note || '')}</td></tr>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(firm)} — ${h(short)} report — ${h(b.generatedAt.slice(0, 10))}</title>
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
    <div class="kicker">${h(fill(R.kicker))}</div>
    <h1>${h(firm)}</h1>
    <p>${h(R.lead)}, as of ${h(date)}.</p>
    <span class="verdict ${open.length ? 'no' : 'ok'}">${h(fw.name)}: ${h(verdict)}</span>
    <dl>
      <dt>Prepared</dt><dd>${h(date)}</dd>
      <dt>Framework</dt><dd>${h(fw.name)}</dd>
      <dt>System</dt><dd>Depot ${h(b.version)}${b.firm?.hostname ? `, ${h(b.firm.hostname)}` : ''}</dd>
      <dt>Where it runs</dt><dd>On the ${h(R.who)}'s own server</dd>
      <dt>Sections</dt><dd>1 ${h(R.section1)} · 2 ${h(R.checklist)} · 3 Who has access · 4 Audit-log check · 5 Settings · 6 Retention and legal holds</dd>
    </dl>
  </div>
  <p class="disc">Produced by Depot from its own settings and records. It describes this system as it stood on the date above. ${h(R.disclaimer)}</p>
</div>

<section>
  <h2><small>Section 1</small>${h(R.section1)}</h2>
  <p class="note">${h(fill(R.section1Note))}</p>
  ${R.prose(b, fw).map(p => `<p>${h(p)}</p>`).join('\n  ')}
</section>

<section>
  <h2><small>Section 2</small>${h(R.checklist)}</h2>
  <p class="note">${h(R.checklistNote)}</p>
  <table><thead><tr><th>Status</th><th>Requirement</th><th>What Depot shows</th><th>Confirmed by</th></tr></thead><tbody>${checklistRows}</tbody></table>
</section>

<section>
  <h2><small>Section 3</small>Who has access</h2>
  ${ar.error ? `<p class="note"><b>The access list could not be produced:</b> ${h(ar.error)}. Do not treat the table below as complete.</p>` : ''}
  <p class="note">${(ar.userCount || (ar.users || []).length || 0) === 1 ? 'One person' : `${ar.userCount || (ar.users || []).length || 0} people`} can sign in. Access comes from owning a library, from a library or folder shared with the person or a group they belong to, or from files shared one by one.${ar.openLibraries?.length ? ` Listed to everyone who signs in (no file access): ${h(ar.openLibraries.join(', '))}.` : ''}</p>
  <table><thead><tr><th>Person</th><th>Role</th><th>Second step</th><th>Owns</th><th>Shared with them</th><th>Groups</th><th>Last active</th></tr></thead><tbody>${accessRows || '<tr><td colspan="7">No one yet.</td></tr>'}</tbody></table>
  ${ar.pendingShares?.length ? `<p class="note">Shared with addresses that have not signed in yet: ${ar.pendingShares.map(p => h(p.email)).join(', ')}.</p>` : ''}
</section>

<section>
  <h2><small>Section 4</small>Audit-log check</h2>
  <p>Depot keeps a record of every view, download, upload, change, share, and deletion, and of every change to who has access. Each entry is chained to the one before it with a cryptographic hash, so an entry that is altered or removed breaks the chain.</p>
  <p>${integrity}</p>
</section>

<section>
  <h2><small>Section 5</small>Settings this ${h(R.what)} relies on</h2>
  <table><thead><tr><th>Setting</th><th>Value on ${h(date)}</th></tr></thead><tbody>${snapshot}</tbody></table>
</section>

<section>
  <h2><small>Section 6</small>Retention and legal holds</h2>
  <p>Each library can say how long its files are kept: a minimum (nothing in it is deleted for good before a file is that old) and, where set, a limit after which a file nobody has changed is moved to the trash on its own, its owner told 30 days ahead. A legal hold stops every deletion, purge, replacement or move of what it covers until an administrator releases it with a note; each hold and release is in the audit record.</p>
  <table><thead><tr><th>Library</th><th>Kept at least</th><th>Disposed of after</th><th>Set by</th></tr></thead><tbody>${retentionRows || '<tr><td colspan="4">No library yet.</td></tr>'}</tbody></table>
  <p class="note">${holdRows ? `${plural(rt.holds.length, 'legal hold')} in place on ${h(date)}:` : 'No legal hold is in place.'}</p>
  ${holdRows ? `<table><thead><tr><th>Hold on</th><th>Since</th><th>Placed by</th><th>Reason</th></tr></thead><tbody>${holdRows}</tbody></table>` : ''}
  ${releasedRows ? `<p class="note">Released recently:</p><table><thead><tr><th>Hold on</th><th>Placed</th><th>Released</th><th>Note</th></tr></thead><tbody>${releasedRows}</tbody></table>` : ''}
</section>
</main></body></html>`;
}

// The Safeguards packet: the report for that framework, under the name the route,
// the tests and the simple view already use.
const toPacketHtml = (b) => toReportHtml(b, undefined, 'safeguards');

// The attachment name: <firm>-<framework>-report-<date>.html.
function reportFileName(firmName, frameworkId, iso) {
  const slug = String(firmName || 'depot').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'depot';
  const fw = String(frameworkId || 'compliance').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `${slug}-${fw}-report-${String(iso || new Date().toISOString()).slice(0, 10)}.html`;
}

module.exports = { build, toMarkdown, toPacketHtml, toReportHtml, reportFileName, PROSE: { safeguards: wispParagraphs, hipaa: hipaaParagraphs, pci_dss: pciScopeParagraphs, nist_csf: nistParagraphs, default: genericParagraphs } };
