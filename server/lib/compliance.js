'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const settings = require('./settings');
const db = require('./db');

const ROOT = path.join(__dirname, '..', '..');

// Control ids a framework may name before the control exists: a later change
// (card-number detection). profileStatus() drops them until the catalog has them.
const UPCOMING = [];

// One requirement: a catalog control, the clause it answers to in this framework, and
// why, in words the office manager can read. `why` always names the clause.
const req = (control, cite, why) => ({ control, cite, why });

const FRAMEWORKS = [
  {
    // Tax and accounting firms are "financial institutions" under the FTC Safeguards
    // Rule (16 CFR 314). The IRS repeats the same expectations in Pub 4557 and the
    // Pub 5708 written-plan template. Listed first: it is the profile a CPA office
    // turns on, and the one the simple "one light, one download" view is built for.
    id: 'safeguards',
    setting: 'compliance_safeguards_enabled',
    name: 'FTC Safeguards Rule (CPA / tax)',
    short: 'Safeguards',
    scope: 'What the FTC Safeguards Rule and IRS Pub 4557 expect of a tax or accounting firm\'s file system.',
    note: 'Readiness of this Depot only. Your firm still owns its written plan, training, and yearly report.',
    requirements: [
      req('mfa', '314.4(c)(5)', '314.4(c)(5): multi-factor authentication for anyone who reaches client information.'),
      req('encryption', '314.4(c)(3)', '314.4(c)(3): client information is encrypted where it is stored.'),
      req('network_security', '314.4(c)(3)', '314.4(c)(3): client information is encrypted in transit (HTTPS).'),
      req('access_control', '314.4(c)(1)', '314.4(c)(1): only the people who need client information can reach it, and the list is reviewed.'),
      req('sensitive_data', '314.4(c)(1) and (c)(2)', '314.4(c)(1) and (c)(2): know where customer information sits. Depot checks each file for card, Social Security and bank numbers and lists what it finds, so a card number that should never have been uploaded is caught.'),
      req('access_review', '314.4(c)(1)', '314.4(c)(1): who has access is reviewed on a schedule, and access is taken away when it is no longer needed.'),
      req('audit_logging', '314.4(c)(8)', '314.4(c)(8): a record of who did what with client information, including views and downloads, that cannot be quietly edited.'),
      req('signin_events', '314.4(c)(8)', '314.4(c)(8): sign-ins and failed sign-ins are recorded, so an attempt to get in by someone unauthorized can be seen.'),
      req('malware_scanning', '314.4(c)(1) and IRS Pub 4557', '314.4(c)(1) and IRS Pub 4557: files are checked for malicious software before anyone opens them.'),
      req('backup_restore', '314.4(c)(1) and (h)', '314.4(c)(1) and (h): you can get client information back after a failure or an incident.'),
      req('link_governance', '314.4(c)(1)', '314.4(c)(1): limit who can reach client information, and for how long.'),
      req('retention', '314.4(c)(6)', '314.4(c)(6): dispose of client information when it is no longer needed. (Tax returns themselves stay at least three years under IRC 6107; Depot keeps a file until someone deletes it.)'),
      req('vulnerability_management', '314.4(d)(2)', '314.4(d)(2): a yearly penetration test and vulnerability scans every six months, unless the system is watched continuously.'),
      req('wisp', '314.4', '314.4: the rule is a written program. IRS Pub 5708 is a free template; the IRS asks about it at PTIN renewal.'),
      req('qualified_individual', '314.4(a)', '314.4(a): a named Qualified Individual runs the program and reports to the owners.'),
      req('risk_assessment', '314.4(b)', '314.4(b): a written look at what could go wrong with client information and what you do about it.'),
      req('incident_response', '314.4(h)', '314.4(h): a written plan for what to do when something goes wrong, including who calls whom.'),
      req('training', '314.4(e)', '314.4(e): security awareness training for everyone, refreshed as risks change.'),
      req('provider_oversight', '314.4(f)', '314.4(f): pick providers that can protect client information, put it in the contract, and check on them.'),
      req('annual_report', '314.4(i)', '314.4(i): the Qualified Individual reports in writing at least once a year.'),
    ],
  },
  {
    id: 'soc2',
    setting: 'compliance_soc2_enabled',
    name: 'SOC 2',
    short: 'SOC 2',
    scope: 'What a customer\'s security review or a SOC 2 examiner asks a file system to show: who gets in, what is recorded, and how changes and incidents are handled.',
    note: 'Readiness profile only. A SOC 2 report is an opinion on the organization, written by a CPA firm after its own examination.',
    requirements: [
      req('access_control', 'CC6.1', 'CC6.1: access to the system is limited to named, authorized people.'),
      req('mfa', 'CC6.1', 'CC6.1: a second step at sign-in, so a stolen password is not enough.'),
      req('access_review', 'CC6.2 and CC6.3', 'CC6.2 and CC6.3: access is reviewed on a schedule and taken away when someone leaves or changes role.'),
      req('encryption', 'CC6.1 and CC6.7', 'CC6.1 and CC6.7: data is encrypted where it is stored.'),
      req('network_security', 'CC6.7', 'CC6.7: data is encrypted on its way to and from people (HTTPS).'),
      req('malware_scanning', 'CC6.8', 'CC6.8: the system guards against malicious software in the files it holds.'),
      req('audit_logging', 'CC7.2', 'CC7.2: what happens in the system is recorded and can be reviewed.'),
      req('signin_events', 'CC6.1 and CC7.2', 'CC6.1 and CC7.2: sign-ins and failed sign-ins are recorded and watched.'),
      req('backup_restore', 'A1.2', 'A1.2: data is backed up and can be recovered.'),
      req('change_management', 'CC8.1', 'CC8.1: changes to the system are tracked and released in an orderly way.'),
      req('vendor_ai', 'CC9.2', 'CC9.2: outside services that see data (an AI provider, say) are known and managed.'),
      req('incident_response', 'CC7.4', 'CC7.4: there is a written plan for responding to an incident.'),
    ],
  },
  {
    // HIPAA's technical safeguards, 45 CFR 164.312, are what a file system can answer
    // to. The rest of the Security Rule (risk analysis, policies, training, business
    // associate agreements) belongs to the covered entity or business associate.
    id: 'hipaa',
    setting: 'compliance_hipaa_enabled',
    name: 'HIPAA',
    short: 'HIPAA',
    scope: 'The technical safeguards in 45 CFR 164.312: who can get in, when they are signed out, what is recorded, and whether patient files are protected where they sit and on the way.',
    note: 'HIPAA certifies organizations, not software. The business associate agreements, the risk analysis, your policies, and staff training are your organization\'s own; this report covers what Depot can show.',
    requirements: [
      req('access_control', '164.312(a)(1) and (a)(2)(i)', '164.312(a)(1) and (a)(2)(i): each person has their own account, so every action can be traced to one named person.'),
      req('sensitive_data', '164.308(a)(1)(ii)(A)', '164.308(a)(1)(ii)(A): the risk analysis starts with knowing where protected information is. Depot checks each file for card, Social Security and bank numbers and lists what it finds.'),
      req('emergency_access', '164.312(a)(2)(ii)', '164.312(a)(2)(ii): a written way to reach patient files in an emergency, when the usual person or sign-in is not available.'),
      req('session_timeout', '164.312(a)(2)(iii)', '164.312(a)(2)(iii): a sign-in ends on its own after a set time, so an unattended screen does not stay open.'),
      req('encryption', '164.312(a)(2)(iv) and (c)(1)', '164.312(a)(2)(iv) and (c)(1): files are encrypted where they are stored, with a cipher that also detects a file altered on disk.'),
      req('audit_logging', '164.312(b)', '164.312(b): a record of who looked at, changed, or shared each file, kept so it cannot be quietly edited.'),
      req('signin_events', '164.312(b) and 164.308(a)(5)(ii)(C)', '164.312(b) and 164.308(a)(5)(ii)(C): sign-ins and failed sign-ins are recorded and watched.'),
      req('mfa', '164.312(d)', '164.312(d): the system checks that a person is who they say they are; a second step at sign-in is the usual way.'),
      req('network_security', '164.312(e)(1)', '164.312(e)(1): files are encrypted on the way to and from people (HTTPS).'),
      req('access_review', '164.308(a)(4)', '164.308(a)(4): who may reach patient files is reviewed, and access is taken away when it is no longer needed.'),
      req('malware_scanning', '164.308(a)(5)(ii)(B)', '164.308(a)(5)(ii)(B): files are checked for malicious software.'),
      req('backup_restore', '164.308(a)(7)(ii)(A)', '164.308(a)(7)(ii)(A): an exact copy of patient files can be recovered after a failure.'),
      req('vendor_ai', '164.308(b)(1)', '164.308(b)(1): an outside service that sees file contents (an AI provider, say) is a business associate and needs an agreement, or stays off.'),
    ],
  },
  {
    id: 'gdpr',
    setting: 'compliance_gdpr_enabled',
    name: 'GDPR',
    short: 'GDPR',
    scope: 'Personal data held in files: who can reach it, how long it stays, how a person\'s request to see or erase it is met, and which outside services process it.',
    note: 'This profile helps track readiness for data-subject requests; it is not legal advice.',
    requirements: [
      req('access_control', 'Article 32(1)(b)', 'Article 32(1)(b): only named, authorized people can reach personal data.'),
      req('encryption', 'Article 32(1)(a)', 'Article 32(1)(a): personal data is encrypted where it is stored.'),
      req('audit_logging', 'Article 5(2) and 30', 'Article 5(2) and 30: the organization can show what was done with personal data.'),
      req('retention', 'Article 5(1)(e)', 'Article 5(1)(e): personal data is not kept longer than needed; deleted files are disposed of on a schedule.'),
      req('export_delete', 'Articles 15 and 17', 'Articles 15 and 17: a person can get a copy of their data, or have it erased, within a month.'),
      req('vendor_ai', 'Article 28', 'Article 28: an outside service that processes personal data (an AI provider, say) is a processor and needs a written contract.'),
    ],
  },
  {
    // PCI DSS certifies merchants and processors, and only for systems that store,
    // process or transmit cardholder data. The right goal for a file store is to be
    // OUT of scope: no card numbers in it, and a way to tell if one slips in.
    id: 'pci_dss',
    setting: 'compliance_pci_dss_enabled',
    name: 'PCI: no card data in Depot',
    short: 'PCI',
    scope: 'Keeping Depot out of PCI scope: a written rule that no card numbers are stored here, the checks that would catch one, and the protections that limit the harm if one slips in.',
    note: 'PCI DSS applies to systems that store, process, or transmit card data. The aim here is that Depot never does; it is not a PCI assessment, and card payments stay in your payment provider\'s own system.',
    requirements: [
      req('no_card_data', 'PCI DSS v4.0, scope', 'PCI DSS v4.0, scope: a system that never stores, processes, or transmits cardholder data is out of scope. A written rule, and staff who know it, keep Depot out.'),
      req('sensitive_data', 'PCI DSS v4.0, Requirement 3 and scope', 'PCI DSS v4.0, Requirement 3 and scope: uploaded files are checked for card numbers, so a slip is caught instead of silently putting Depot in scope.'),
      req('access_control', 'Requirement 7', 'Requirement 7: access is limited to named people who need it.'),
      req('mfa', 'Requirement 8.4', 'Requirement 8.4: a second step at sign-in for everyone.'),
      req('access_review', 'Requirement 7.2.4', 'Requirement 7.2.4: who has access is reviewed at least every six months.'),
      req('audit_logging', 'Requirement 10', 'Requirement 10: a record of who did what, kept so it cannot be quietly edited.'),
      req('signin_events', 'Requirement 10.2.1.4', 'Requirement 10.2.1.4: failed sign-ins are recorded.'),
      req('encryption', 'Requirement 3.5', 'Requirement 3.5: if a card number did slip into a file, it would sit encrypted on disk.'),
      req('network_security', 'Requirement 4', 'Requirement 4: files travel over HTTPS, never in the clear.'),
      req('retention', 'Requirement 3.2.1', 'Requirement 3.2.1: nothing is kept longer than needed; deleted files are disposed of on a schedule.'),
      req('malware_scanning', 'Requirement 5', 'Requirement 5: files are checked for malicious software.'),
      req('vulnerability_management', 'Requirement 11', 'Requirement 11: the server is scanned for weaknesses on a schedule.'),
    ],
  },
  {
    // NIST CSF 2.0's six functions, in plain words, mapped to what Depot can show.
    id: 'nist_csf',
    setting: 'compliance_nist_csf_enabled',
    name: 'NIST Cybersecurity Framework 2.0',
    short: 'NIST CSF',
    scope: 'The six functions of NIST CSF 2.0 (Govern, Identify, Protect, Detect, Respond, Recover) as they apply to a file system, in plain words.',
    note: 'The framework is a way of organizing a program, not a certification. Depot answers the parts a file system can; the governance, risk and planning parts are your organization\'s own.',
    requirements: [
      req('qualified_individual', 'Govern, GV.RR-02', 'Govern (GV.RR-02): one named person is responsible for security and reports to leadership.'),
      req('provider_oversight', 'Govern, GV.SC-05', 'Govern (GV.SC-05): outside providers that touch your data are under written terms and checked on.'),
      req('risk_assessment', 'Identify, ID.RA-01', 'Identify (ID.RA-01): what could go wrong with your data is written down and reviewed.'),
      req('vulnerability_management', 'Identify, ID.RA-01', 'Identify (ID.RA-01): the server is scanned for weaknesses on a schedule.'),
      req('access_control', 'Protect, PR.AA-01', 'Protect (PR.AA-01): each person has their own account and a role.'),
      req('mfa', 'Protect, PR.AA-03', 'Protect (PR.AA-03): a second step at sign-in.'),
      req('access_review', 'Protect, PR.AA-05', 'Protect (PR.AA-05): who has access is reviewed and kept to what each person needs.'),
      req('encryption', 'Protect, PR.DS-01', 'Protect (PR.DS-01): files are encrypted where they are stored.'),
      req('network_security', 'Protect, PR.DS-02', 'Protect (PR.DS-02): files are encrypted on the way to and from people (HTTPS).'),
      req('training', 'Protect, PR.AT-01', 'Protect (PR.AT-01): staff are trained to recognize and avoid security risks.'),
      req('change_management', 'Protect, PR.PS-01', 'Protect (PR.PS-01): changes to the system are tracked and released in an orderly way.'),
      req('audit_logging', 'Detect, DE.CM-01', 'Detect (DE.CM-01): what happens in the system is recorded, so something wrong can be noticed.'),
      req('signin_events', 'Detect, DE.CM-03', 'Detect (DE.CM-03): sign-ins and failed sign-ins are recorded and watched.'),
      req('malware_scanning', 'Detect, DE.CM-09', 'Detect (DE.CM-09): files are checked for malicious software.'),
      req('incident_response', 'Respond, RS.MA-01', 'Respond (RS.MA-01): a written plan says who does what when something goes wrong.'),
      req('backup_restore', 'Recover, RC.RP-01', 'Recover (RC.RP-01): backups run and can be restored, so work resumes after a failure.'),
    ],
  },
  {
    id: 'iso27001',
    setting: 'compliance_iso27001_enabled',
    name: 'ISO/IEC 27001',
    short: 'ISO 27001',
    scope: 'The Annex A controls a file system can show evidence for: access, encryption, logging, backups, change and incident handling.',
    note: 'Product controls can support an ISMS, but certification is organization-wide.',
    requirements: [
      req('risk_register', 'Clause 6.1.2', 'Clause 6.1.2: risks are listed with an owner and a treatment.'),
      req('access_control', 'Annex A 5.15', 'Annex A 5.15: access is limited to named, authorized people.'),
      req('mfa', 'Annex A 8.5', 'Annex A 8.5: a second step at sign-in.'),
      req('encryption', 'Annex A 8.24', 'Annex A 8.24: data is encrypted where it is stored.'),
      req('audit_logging', 'Annex A 8.15', 'Annex A 8.15: what happens in the system is recorded and protected from editing.'),
      req('backup_restore', 'Annex A 8.13', 'Annex A 8.13: backups run and are tested.'),
      req('change_management', 'Annex A 8.32', 'Annex A 8.32: changes to the system are tracked and released in an orderly way.'),
      req('incident_response', 'Annex A 5.24', 'Annex A 5.24: a written plan says who does what when something goes wrong.'),
    ],
  },
  {
    id: 'cmmc',
    setting: 'compliance_cmmc_enabled',
    name: 'CMMC',
    short: 'CMMC',
    scope: 'The NIST SP 800-171 practices a file system can show for a defense contractor handling federal contract information.',
    note: 'Do not store CUI until scoping, the system security plan, SPRS/eMASS evidence, and required assessments are ready.',
    requirements: [
      req('access_control', 'SP 800-171 3.1.1', 'SP 800-171 3.1.1: access is limited to authorized people, each with their own account.'),
      req('mfa', 'SP 800-171 3.5.3', 'SP 800-171 3.5.3: a second step at sign-in.'),
      req('audit_logging', 'SP 800-171 3.3.1', 'SP 800-171 3.3.1: a record of who did what, kept so it cannot be quietly edited.'),
      req('encryption', 'SP 800-171 3.13.16', 'SP 800-171 3.13.16: files are encrypted where they are stored.'),
      req('network_security', 'SP 800-171 3.13.8', 'SP 800-171 3.13.8: files are encrypted on the way to and from people (HTTPS).'),
      req('retention', 'SP 800-171 3.8.3', 'SP 800-171 3.8.3: data is disposed of when it is no longer needed.'),
      req('vulnerability_management', 'SP 800-171 3.11.2', 'SP 800-171 3.11.2: the server is scanned for weaknesses on a schedule.'),
    ],
  },
];
// `controls` stays derivable from the requirements for everything that reads it.
for (const f of FRAMEWORKS) f.controls = f.requirements.map(r => r.control);

// `evidence` here is the default/fallback copy; auto controls override it with a live
// signal (see CHECKS), and manual controls override it with the attestation note.
// The clause a control answers to, and why, is per framework: FRAMEWORKS[].requirements.
// `fix` points the client at the place the admin can put it right ('setup:mfa',
// 'setup:session', 'settings:<key>', 'backup').
// `attestable` auto controls accept a manual confirmation when the live signal is
// not green — for the things Depot can only see from outside (MFA enforced by a
// Microsoft tenant, say).
const CONTROL_CATALOG = {
  mfa: {
    label: 'A second step at sign-in (MFA)',
    evidence: 'Sign-in goes through Keycloak; a one-time code can be required for every local account.',
    gap: 'Require an authenticator app for password sign-ins (Settings › Sign-in methods), or confirm your Microsoft 365 tenant requires a second step.',
    fix: 'setup:mfa',
    attestable: true,
  },
  link_governance: {
    label: 'Links to outside people expire',
    evidence: 'Share links can carry an expiry date and a password.',
    gap: 'Set the longest a link may live (Settings › Network, limits & calls) and retire links that never expire.',
    fix: 'settings:share_link_max_days',
  },
  wisp: {
    label: 'A written security plan (WISP)',
    manual: true,
    evidence: 'Depot cannot see your written plan. Confirm here once it exists, and keep it with your firm records.',
    gap: 'Write the plan (IRS Pub 5708 template), have the owners sign it, and confirm here.',
  },
  qualified_individual: {
    label: 'One person is in charge of security',
    manual: true,
    evidence: 'Depot cannot see who holds this role. Confirm here, naming the person in the note.',
    gap: 'Name the person (an owner, office manager, or your IT provider) and confirm here.',
  },
  risk_assessment: {
    label: 'A written risk assessment',
    manual: true,
    evidence: 'Depot cannot see the assessment. Confirm here once it is written.',
    gap: 'Write it (the Pub 5708 template has a section), review it yearly, and confirm here.',
  },
  training: {
    label: 'Staff trained on security this year',
    manual: true,
    evidence: 'Depot cannot see training records. Confirm here each year with the date in the note.',
    gap: 'Run a short session (phishing, passwords, client data handling), keep the sign-in sheet, and confirm here.',
  },
  provider_oversight: {
    label: 'Service providers are checked',
    manual: true,
    evidence: 'Depot cannot see your contracts. Confirm here once your IT and software providers are under written terms.',
    gap: 'Keep a list of providers that touch client data, with a signed agreement for each, and confirm here.',
  },
  annual_report: {
    label: 'A yearly report to the owners',
    manual: true,
    evidence: 'Depot cannot see the report. The Safeguards packet from this page is written to be attached to it.',
    gap: 'Attach this page\'s packet to a short written report each year, and confirm here with the date.',
  },
  access_control: {
    label: 'Only named people can get in',
    evidence: 'Everyone signs in with their own account and has a role: admin, contributor, or viewer.',
    gap: 'Give each person an account and a role; make at least one person an admin.',
  },
  audit_logging: {
    label: 'A record of who did what',
    evidence: 'Every view, download, upload, change, share, and deletion is logged, and the log is hash-chained so a changed or deleted entry is detectable.',
    gap: 'The log fills itself in as people use Depot; nothing to set up.',
  },
  encryption: {
    label: 'Files are encrypted where they are stored',
    fix: 'settings:storage_encryption_key',
    evidence: 'Files on disk are encrypted (AES-256-GCM) with a key only the server holds.',
    gap: 'Set an encryption key (Settings › Storage & backups). Files uploaded before that are not encrypted.',
  },
  backup_restore: {
    label: 'Backups run and can be restored',
    fix: 'backup',
    evidence: 'Depot can back itself up on a schedule and check that a backup restores.',
    gap: 'Turn on scheduled backups (Settings › Storage & backups), or back up the whole server another way and confirm it here.',
    attestable: true,
  },
  change_management: {
    label: 'Updates are tracked',
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
    manual: true,
    evidence: 'Depot cannot see your plan. Confirm here once it is written.',
    gap: 'Write one page: who to call, how to cut off access, who tells clients, the FTC, and the state (Louisiana gives you 60 days to notify people; the FTC wants 30 days for 500 or more). Confirm here.',
  },
  retention: {
    label: 'Deleted files are disposed of on a schedule',
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
    manual: true,
    evidence: 'Depot updates itself, and "Run live checks" audits its own components. The twice-yearly scan of the server is your IT provider\'s to run and keep.',
    gap: 'Have your IT provider scan the server every six months and keep the report; confirm here with the date.',
  },
  network_security: {
    label: 'Files are encrypted on the way to you',
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
  emergency_access: {
    label: 'A written way in during an emergency',
    manual: true,
    evidence: 'Depot cannot see your procedure. Confirm here once it says who can reach patient files when the usual person or sign-in is not available.',
    gap: 'Write one page: who holds a second administrator account, where its credentials are sealed, and who may open them. Confirm here.',
  },
  session_timeout: {
    label: 'People are signed out after a set time',
    evidence: 'A sign-in ends on its own after the time set under Sign-in methods.',
    gap: 'Set how long a sign-in lasts to a day or less (Settings › Sign-in methods), or confirm your Microsoft 365 tenant signs people out.',
    fix: 'setup:session',
    attestable: true,
  },
  no_card_data: {
    label: 'No cardholder data is stored here (written rule)',
    manual: true,
    evidence: 'Depot cannot read your policy. Confirm here once a written rule says card numbers never go into Depot, and staff know where payments do go.',
    gap: 'Write the rule (one paragraph: card numbers are never typed into or uploaded to Depot; payments go through the card terminal or payment provider), tell staff, and confirm here.',
  },
  malware_scanning: {
    label: 'Uploads are scanned for malware',
    why: 'HIPAA §164.308(a)(5)(ii)(B) and FTC Safeguards 314.4(c): protection from malicious software.',
    evidence: 'Every file that enters Depot, by upload, by a link, or from the drive, is checked by a virus scanner before it is kept; a file that fails is refused and the administrators are told.',
    gap: 'Start the scanner on the server (COMPOSE_PROFILES=clamav in .env, then upgrade.sh) and switch scanning on in Settings › Storage & backups.',
    fix: 'settings:malware_scan_enabled',
  },
  // `action` is a button the window draws on the row whatever its state: the admin does
  // the thing from Compliance without leaving. { label, api } — a POST, with an optional note.
  access_review: {
    label: 'Who has access is reviewed every quarter',
    why: 'FTC Safeguards 314.4(c)(1), HIPAA §164.308(a)(4), SOC 2 CC6.2: periodic review of who can get in.',
    evidence: 'Settings › Users & access lists every person and what they can open. Record each review there, or here.',
    gap: 'Look through the list in Settings › Users & access, remove anyone who should not be on it, and record that it was reviewed.',
    fix: 'access',
    action: { label: 'Record that this list was reviewed', api: '/admin/access-review/signoff' },
  },
  signin_events: {
    label: 'Sign-ins and failed sign-ins are recorded',
    why: 'HIPAA §164.312(b), SOC 2 CC7.2: activity review includes authentication.',
    evidence: 'Every sign-in, failed sign-in and sign-out is copied from Keycloak into the hash-chained activity record every five minutes.',
    gap: 'Turn sign-in records on (Settings › Server, signin_events_enabled) and make sure Keycloak is keeping events for the realm.',
    fix: 'settings:signin_events_enabled',
  },
  sensitive_data: {
    label: 'No card numbers are stored in Depot',
    evidence: 'Every file\'s text is checked for payment card numbers (and, as information, Social Security and bank numbers) as it arrives; what is found is listed under Findings until an administrator resolves it or deletes the file.',
    gap: 'Open Findings in the Compliance window: each file that holds what looks like a card number is listed with where it is. Delete the file or move the number out of Depot, or mark the finding resolved with a note. Card detection must be on (Compliance › Findings).',
    fix: 'compliance:findings',
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
  session_timeout: async () => {
    const hours = Number(await settings.get('login_session_hours'));
    const set = Number.isFinite(hours) && hours > 0;
    const ready = set && hours <= 24;
    return {
      ready,
      evidence: ready
        ? `A sign-in ends on its own after ${hours} hour${hours === 1 ? '' : 's'}.`
        : set
          ? `A sign-in lasts ${hours} hours before it ends on its own — longer than the day this profile expects.`
          : 'How long a sign-in lasts has not been set here; Keycloak\'s default applies.',
    };
  },
  mfa: async () => {
    const required = String((await settings.get('mfa_required')) || '').toLowerCase() === 'true';
    const ms365 = boolValue(await settings.getOrEnv('login_ms365_enabled'));
    // Per person, from Keycloak (lib/keycloakAdmin mfaStatusByUser): the switch says the
    // rule, the count says whether everyone has followed it yet.
    let people = null;
    try { people = (await require('./keycloakAdmin').mfaStatusByUser()).users; } catch { /* unreachable, or no admin credentials here */ }
    if (people) {
      const n = (st) => people.filter(u => u.state === st).length;
      const federated = people.filter(u => u.state === 'federated');
      const ms = federated.filter(u => u.provider === 'microsoft').length, ad = federated.length - ms;
      const local = people.length - federated.length;
      const counts = [`${n('enrolled')} of ${people.length} ${people.length === 1 ? 'person' : 'people'} enrolled`, `${n('pending')} pending`];
      if (ms) counts.push(`${ms} through Microsoft 365`);
      if (ad) counts.push(`${ad} through Active Directory`);
      const line = counts.join(', ') + '.';
      const uncovered = n('none') + n('pending');
      if (required && !uncovered) return { ready: true, evidence: `Every local account must enter a one-time code at sign-in. ${line}` };
      if (required) return { ready: false, evidence: `A one-time code is required, but ${uncovered} ${uncovered === 1 ? 'person has' : 'people have'} not set one up yet. ${line}` };
      if (!local) return { ready: false, evidence: `${line} Sign-in is through ${ms ? 'Microsoft 365' : 'your identity provider'}. Depot cannot see whether it requires a second step — confirm it below once it does.` };
      return { ready: false, evidence: `A one-time code is not required at sign-in — a stolen password is enough to reach client files. ${line}` };
    }
    if (required) {
      return { ready: true, evidence: 'Every local account must enter a one-time code at sign-in (required action in Keycloak). Who has set one up could not be counted: Keycloak did not answer.' };
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
  malware_scanning: async () => {
    // Green only when scanning is on AND the scanner answered within the last hour: an
    // enabled switch with a dead scanner refuses every upload, which is not protection.
    // The ping is cached (lib/malwareScan.status), never made on each page load.
    const scan = require('./malwareScan');
    const st = await scan.status();
    const refused = await scan.refusedCount(30);
    const when = (iso) => new Date(iso).toLocaleString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const day = (iso) => new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const refusedLine = `${refused} ${refused === 1 ? 'file' : 'files'} refused in the last 30 days`;
    if (!st.enabled) return { ready: false, evidence: `Virus scanning is off: files are stored as they arrive. ${refusedLine}.` };
    if (!st.answering) return { ready: false, evidence: `Virus scanning is on but the scanner is not answering${st.error ? ` (${st.error})` : ''}; uploads are being refused until it does. ${refusedLine}.` };
    return {
      ready: true,
      evidence: `Every upload is scanned (${st.version || 'ClamAV'}, signatures from ${st.signatureDate ? day(st.signatureDate) : 'an unknown date'}); the scanner answered ${st.checkedAt ? when(st.checkedAt) : 'recently'}. Last scan ${st.lastScanAt ? when(st.lastScanAt) : 'not yet'}. ${refusedLine}.`,
    };
  },
  access_review: async () => {
    const review = require('./accessReview');
    const last = await review.latest();
    if (!last) return { ready: false, evidence: 'No review has been recorded yet.' };
    const at = new Date(last.reviewed_at);
    const ageDays = Math.floor((Date.now() - at.getTime()) / 86400e3);
    const when = at.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const who = last.reviewed_by_email || 'an administrator';
    const line = `Last reviewed ${when} by ${who}${last.user_count ? ` (${last.user_count} ${last.user_count === 1 ? 'person' : 'people'} on the list)` : ''}${last.note ? ` · ${last.note}` : ''}.`;
    return ageDays <= review.REVIEW_DAYS
      ? { ready: true, evidence: line }
      : { ready: false, evidence: `${line} That is ${ageDays} days ago — more than a quarter.` };
  },
  signin_events: async () => {
    const poller = require('./signInEvents');
    const st = await poller.status();
    let counts = { signed_in: 0, sign_in_failed: 0, signed_out: 0 };
    try {
      const rows = await db.query(
        `SELECT event_type, count(*)::int AS n FROM document_events WHERE event_type = ANY($1) AND created_at >= now() - INTERVAL '30 days' GROUP BY event_type`,
        [poller.EVENT_TYPES]);
      for (const r of rows || []) counts[r.event_type] = r.n;
    } catch { /* table may be absent on a fresh install */ }
    const line = `In the last 30 days: ${counts.signed_in} sign-in${counts.signed_in === 1 ? '' : 's'}, ${counts.sign_in_failed} failed, ${counts.signed_out} sign-out${counts.signed_out === 1 ? '' : 's'}.`;
    if (!st.enabled) return { ready: false, evidence: `Sign-in records are switched off (signin_events_enabled). ${line}` };
    if (!st.last) return { ready: false, evidence: `Sign-in records are on but have not been read from Keycloak yet (the first pass runs a minute after start). ${line}` };
    if (st.last.eventsEnabled === false) return { ready: false, evidence: `Keycloak is not keeping sign-in records for the realm, so there is nothing to copy. Turn on events in Keycloak (Realm settings › Events). ${line}` };
    if (!st.last.ok) return { ready: false, evidence: `The last read from Keycloak failed: ${st.last.error}. ${line}` };
    return { ready: true, evidence: `Copied from Keycloak into the hash-chained record every five minutes; last read ${new Date(st.last.at).toLocaleString('en-US')}. ${line}` };
  },
  sensitive_data: async () => {
    // Green when card detection is on and no card finding is open. Social Security and
    // bank findings are reported but never fail this control: a tax office holds them.
    const sd = require('./sensitiveData');
    const s = await sd.summary();
    const when = (iso) => new Date(iso).toLocaleString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const n = (k) => `${s.open[k]} open, ${s.resolved[k]} resolved`;
    const files = `${s.files_checked.toLocaleString()} of ${s.files_total.toLocaleString()} files checked${s.last_check_at ? `, last ${when(s.last_check_at)}` : ''}`;
    const tail = `Card numbers: ${n('card')}. Social Security numbers: ${s.modes.ssn === 'flag' ? n('ssn') : 'not checked'}. Bank numbers: ${s.modes.bank === 'flag' ? n('bank') : 'not checked'}. ${files}.`;
    if (s.modes.card !== 'flag') return { ready: false, evidence: `Card numbers are not being checked for. ${tail}` };
    if (s.open.card > 0) return { ready: false, evidence: `${s.open.card} file${s.open.card === 1 ? ' holds' : 's hold'} what looks like a payment card number. ${tail}` };
    return { ready: true, evidence: `Every file is checked for card numbers as it arrives, and none is open. ${tail}` };
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
        id, label: base.label, gap: base.gap, why: base.why || '', fix: base.fix || null, action: base.action || null, manual: false,
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
    const controls = f.requirements.map(r => evaluated[r.control] && { ...evaluated[r.control], cite: r.cite, why: r.why }).filter(Boolean);
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

module.exports = { FRAMEWORKS, UPCOMING, CONTROL_CATALOG, CHECKS, profileStatus, summary, updateStatus, boolValue, setAttestation, getAttestations, runProbes, probeMeta };
