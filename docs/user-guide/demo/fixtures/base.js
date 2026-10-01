// Shared demo world: Acme Co. Everything here is made up.
//
// The reader is Jordan Lee (jordan.lee@acme.example, contributor). Colleagues: Priya Shah,
// Marcus Chen, Elena Garcia, Sam Okafor (all @acme.example). Outside contact: Dana Whitfield
// (dana@northfield-clinic.example). Five libraries, ~45 files, links, notifications,
// groups, two connections and presence. Dates are relative to when the demo server loads.
//
// Response shapes follow the real routes (server/routes/*.js, lib/linkList.js,
// lib/accessKeys.js, lib/libraries.js ...). Writes are harmless: they answer with
// plausible success JSON and change nothing, so every shot sees the same world.
// A chapter fixture (fixtures/<chapter>.js) can override any route; it can also reuse
// this world: `const base = require('./base'); base.world.FILES ...`.
'use strict';
const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, '..', 'assets');
const NOW = Date.now();
const MIN = 60e3, HOUR = 3600e3, DAY = 864e5;
const ago = (ms) => new Date(NOW - ms).toISOString();
const ahead = (ms) => new Date(NOW + ms).toISOString();
// Stable, valid UUIDs (the app refuses anything else in share links and previews).
const U = (n) => `4d3e5f60-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ─── people ───
const PEOPLE = {
  jordan: { id: U(101), email: 'jordan.lee@acme.example', name: 'Jordan Lee', role: 'contributor' },
  priya: { id: U(102), email: 'priya.shah@acme.example', name: 'Priya Shah', role: 'contributor' },
  marcus: { id: U(103), email: 'marcus.chen@acme.example', name: 'Marcus Chen', role: 'contributor' },
  elena: { id: U(104), email: 'elena.garcia@acme.example', name: 'Elena Garcia', role: 'contributor' },
  sam: { id: U(105), email: 'sam.okafor@acme.example', name: 'Sam Okafor', role: 'contributor' },
  dana: { id: null, email: 'dana@northfield-clinic.example', name: 'Dana Whitfield', role: null },
};
const ME = PEOPLE.jordan;
const byEmail = (e) => Object.values(PEOPLE).find(p => p.email === String(e || '').toLowerCase()) || null;
const nameOf = (e) => byEmail(e)?.name || null;
const person = (e) => (e ? { email: e, name: nameOf(e) } : null);

// ─── libraries ───
const LIB = { jordan: U(201), client: U(202), marketing: U(203), finance: U(204), ops: U(205) };
const LIBRARIES = [
  { id: LIB.jordan, name: 'Jordan Lee', personal: true, owner: 'jordan', created_at: ago(400 * DAY), my_access: 'owner', add_right: 'owner', can_manage: true, shared: false, shared_folders: [], my_folders: [] },
  { id: LIB.client, name: 'Client Projects', personal: false, owner: 'jordan', created_at: ago(380 * DAY), my_access: 'owner', add_right: 'owner', can_manage: true, shared: true, shared_folders: ['Northfield Clinic'], my_folders: [] },
  { id: LIB.marketing, name: 'Marketing', personal: false, owner: 'priya', created_at: ago(700 * DAY), my_access: 'rw', add_right: 'grant', can_manage: false, my_folders: [] },
  { id: LIB.finance, name: 'Finance', personal: false, owner: 'marcus', created_at: ago(720 * DAY), my_access: 'r', add_right: null, can_manage: false, my_folders: [] },
  { id: LIB.ops, name: 'Operations', personal: false, owner: 'elena', created_at: ago(650 * DAY), my_access: 'folders', add_right: null, can_manage: false, my_folders: [{ path: 'Onboarding', level: 'r' }] },
];
const libById = (id) => LIBRARIES.find(l => l.id === id) || null;
function libOut(l) {
  const o = PEOPLE[l.owner];
  const out = { id: l.id, name: l.name, personal: l.personal, archived_at: null, created_by_email: o.email, created_at: l.created_at, owner_id: o.id, owner_email: o.email,
    can_manage: l.can_manage, my_access: l.my_access, my_folders: l.my_folders, add_right: l.add_right };
  if (l.can_manage) { out.shared = l.shared; out.shared_folders = l.shared_folders; }
  return out;
}

// ─── files ───
// [library, path, size, age, uploader, asset slug]; the asset is demo/assets/files/<slug>.<ext>
// and demo/assets/thumbs/<slug>.webp (see make-assets.js).
const KB = 1024, MB = 1024 * 1024;
const FILE_ROWS = [
  // Jordan Lee (personal)
  ['jordan', 'Meeting notes.md', 4.3 * KB, 2 * HOUR, 'jordan', 'meeting-notes'],
  ['jordan', 'Q3 budget.xlsx', 38 * KB, 26 * HOUR, 'jordan', 'q3-budget'],
  ['jordan', 'Q3 review.pptx', 2.8 * MB, 3 * DAY, 'jordan', 'q3-review'],
  ['jordan', 'Expenses September.csv', 6 * KB, 5 * DAY, 'jordan', 'expenses-september'],
  ['jordan', 'Travel itinerary.pdf', 182 * KB, 9 * DAY, 'jordan', 'travel-itinerary'],
  ['jordan', 'Proposals/Proposal template.docx', 46 * KB, 40 * DAY, 'jordan', 'proposal-template'],
  ['jordan', 'Proposals/2026/Northfield Clinic proposal.docx', 212 * KB, 4 * HOUR, 'jordan', 'northfield-proposal'],
  ['jordan', 'Proposals/2026/Intake form - signed.pdf', 148 * KB, 25 * MIN, 'dana', 'intake-form'],
  ['jordan', 'Proposals/2026/Maple Street Bakery proposal.docx', 168 * KB, 6 * DAY, 'jordan', 'maple-proposal'],
  ['jordan', 'Proposals/2026/Harbor Point Dental proposal.pdf', 1.1 * MB, 12 * DAY, 'jordan', 'harbor-point-proposal'],
  ['jordan', 'Proposals/2025/Riverside Library proposal.pdf', 860 * KB, 140 * DAY, 'jordan', 'riverside-proposal'],
  ['jordan', 'Contracts/Northfield Clinic service agreement.pdf', 420 * KB, 2 * DAY, 'jordan', 'northfield-agreement'],
  ['jordan', 'Contracts/Maple Street Bakery contract.pdf', 390 * KB, 20 * DAY, 'jordan', 'maple-contract'],
  ['jordan', 'Photos/Team offsite photo.jpg', 3.4 * MB, 30 * HOUR, 'jordan', 'offsite'],
  ['jordan', 'Photos/Whiteboard sketch.png', 1.6 * MB, 3 * DAY, 'jordan', 'whiteboard'],
  ['jordan', 'Photos/New office.jpg', 2.9 * MB, 15 * DAY, 'jordan', 'new-office'],
  ['jordan', 'Reports/Monthly report - September.docx', 96 * KB, 5 * HOUR, 'jordan', 'monthly-report-sep'],
  ['jordan', 'Reports/Monthly report - August.pdf', 740 * KB, 29 * DAY, 'jordan', 'monthly-report-aug'],
  ['jordan', 'Reports/Client satisfaction survey.xlsx', 54 * KB, 8 * DAY, 'jordan', 'survey'],
  // Client Projects (Jordan's, shared with Priya, Sam and the Northfield project group)
  ['client', 'Northfield Clinic/Kickoff agenda.docx', 28 * KB, 7 * DAY, 'jordan', 'kickoff-agenda'],
  ['client', 'Northfield Clinic/Project schedule.xlsx', 44 * KB, 2 * DAY, 'jordan', 'project-schedule'],
  ['client', 'Northfield Clinic/Floor plan.pdf', 2.2 * MB, 7 * DAY, 'sam', 'floor-plan'],
  ['client', 'Northfield Clinic/Site photos/Reception.jpg', 2.1 * MB, 6 * DAY, 'sam', 'reception'],
  ['client', 'Northfield Clinic/Site photos/Waiting room.jpg', 2.4 * MB, 6 * DAY, 'sam', 'waiting-room'],
  ['client', 'Maple Street Bakery/Menu redesign.pdf', 1.8 * MB, 11 * DAY, 'priya', 'menu-redesign'],
  ['client', 'Maple Street Bakery/Logo concepts.png', 900 * KB, 11 * DAY, 'priya', 'logo-concepts'],
  ['client', 'Harbor Point Dental/Requirements.docx', 64 * KB, 13 * DAY, 'jordan', 'requirements'],
  ['client', 'Archive/.keep', 0, 90 * DAY, 'jordan', null],
  // Marketing (Priya's; Jordan has Read-Write)
  ['marketing', 'Brand/Brand guidelines.pdf', 4.6 * MB, 25 * DAY, 'priya', 'brand-guidelines'],
  ['marketing', 'Brand/Acme logo.png', 240 * KB, 60 * DAY, 'priya', 'acme-logo'],
  ['marketing', 'Brand/Color palette.png', 120 * KB, 60 * DAY, 'priya', 'color-palette'],
  ['marketing', 'Campaigns/Autumn 2026/Hero banner.jpg', 1.2 * MB, 3 * HOUR, 'priya', 'hero-banner'],
  ['marketing', 'Campaigns/Autumn 2026/Social calendar.xlsx', 41 * KB, 3 * HOUR + 4 * MIN, 'priya', 'social-calendar'],
  ['marketing', 'Campaigns/Autumn 2026/Campaign brief.docx', 88 * KB, 3 * DAY, 'priya', 'campaign-brief'],
  ['marketing', 'Newsletter - October.docx', 72 * KB, 4 * HOUR + 20 * MIN, 'jordan', 'newsletter-oct'],
  ['marketing', 'Product launch.pptx', 5.2 * MB, 14 * DAY, 'priya', 'product-launch'],
  // Finance (Marcus's; Jordan has Read-only)
  ['finance', 'Budgets/FY2026 budget.xlsx', 120 * KB, 21 * DAY, 'marcus', 'fy2026-budget'],
  ['finance', 'Invoices/Invoice 1042 - Northfield Clinic.pdf', 96 * KB, 4 * DAY, 'marcus', 'invoice-1042'],
  ['finance', 'Invoices/Invoice 1043 - Maple Street Bakery.pdf', 94 * KB, 4 * DAY, 'marcus', 'invoice-1043'],
  ['finance', 'Reports/Q2 financial summary.pdf', 610 * KB, 45 * DAY, 'marcus', 'q2-summary'],
  ['finance', 'Expense policy.pdf', 280 * KB, 90 * DAY, 'marcus', 'expense-policy'],
  // Operations (Elena's; only the Onboarding folder is shared with Jordan, plus one file given directly)
  ['ops', 'Onboarding/New starter guide.pdf', 1.3 * MB, 30 * DAY, 'elena', 'new-starter-guide'],
  ['ops', 'Onboarding/IT setup checklist.docx', 40 * KB, 30 * DAY, 'sam', 'it-setup-checklist'],
  ['ops', 'Onboarding/Office map.png', 700 * KB, 30 * DAY, 'elena', 'office-map'],
  ['ops', 'Onboarding/Wi-Fi and printer setup.txt', 1.9 * KB, 30 * DAY, 'sam', 'wifi-setup'],
  ['ops', 'Office move plan.pdf', 520 * KB, 2 * DAY + 3 * HOUR, 'elena', 'office-move-plan'],
];
const MIME = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', jpg: 'image/jpeg', png: 'image/png', md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', keep: 'application/octet-stream' };
const extOf = (n) => String(n).split('.').pop().toLowerCase();
const FILES = FILE_ROWS.map(([lib, name, size, age, who, asset], i) => {
  const up = PEOPLE[who];
  return {
    id: U(1001 + i), name, size: Math.round(size), mime_type: MIME[extOf(name)] || 'application/octet-stream', storage_path: `demo/${U(1001 + i)}`,
    uploaded_by: up.id, uploaded_by_email: up.email, uploaded_by_name: up.name, created_at: ago(age),
    deleted_at: null, deleted_by: null, deleted_by_email: null, restored_at: null, restored_by: null, restored_by_email: null,
    library_id: LIB[lib], library_scoped: true, _asset: asset, _lib: lib,
  };
});
const F = Object.fromEntries(FILES.map(f => [f.name.split('/').pop().replace(/\.[^.]+$/, ''), f]));   // by base name, for this file's own use
const fileById = (id) => FILES.find(f => f.id === id) || TRASH.find(f => f.id === id) || null;
const pub = (f) => { const { _asset, _lib, ...rest } = f; return rest; };
// The one file given to Jordan directly (Elena, Can view): it is all Jordan sees at the Operations root.
const DIRECT = { file: F['Office move plan'], by: PEOPLE.elena, at: ago(2 * DAY + 3 * HOUR), grant: U(701) };
// Where Jordan may add or change things (mirrors canWriteHere / canChangeFile).
const writable = (f) => ['jordan', 'client', 'marketing'].includes(f._lib);
const managed = (f) => ['jordan', 'client'].includes(f._lib);

// ─── trash ───
const TRASH = [
  ['jordan', 'Proposals/2026/Northfield Clinic proposal v1.docx', 188 * KB, 20 * DAY, 26 * HOUR],
  ['marketing', 'Brand/Old logo draft.png', 310 * KB, 80 * DAY, 2 * DAY],
  ['jordan', 'Budget notes.txt', 3 * KB, 30 * DAY, 6 * DAY],
  ['jordan', 'Photos/IMG_2041.jpg', 2.7 * MB, 40 * DAY, 12 * DAY],
].map(([lib, name, size, age, gone], i) => ({
  id: U(1901 + i), name, size: Math.round(size), mime_type: MIME[extOf(name)] || 'application/octet-stream', storage_path: `demo/${U(1901 + i)}`,
  uploaded_by: ME.id, uploaded_by_email: ME.email, created_at: ago(age), deleted_at: ago(gone), deleted_by: ME.id, deleted_by_email: ME.email,
  restored_at: null, restored_by: null, restored_by_email: null, library_id: LIB[lib], library_scoped: true,
}));

// ─── links Jordan made (My links) ───
const SITE = 'https://depot.acme.example';
const LINKS = [
  { id: U(301), doc: F['Northfield Clinic proposal'], created: 3 * DAY, expires: ahead(27 * DAY), recipient: PEOPLE.dana.email, allow_upload: true, opened: 26 * HOUR, count: 3, last: 26 * HOUR, token: 'demo-link-northfield-proposal', state: 'active' },
  { id: U(302), doc: F['Brand guidelines'], created: 18 * DAY, expires: null, count: 12, last: 4 * DAY, token: 'demo-link-brand-guidelines', state: 'active' },
  { id: U(303), doc: F['Harbor Point Dental proposal'], created: 12 * DAY, expires: ahead(5 * DAY), password: true, count: 2, last: 9 * DAY, token: 'demo-link-harbor-point-proposal', state: 'active' },
  { id: U(304), doc: F['Team offsite photo'], created: 10 * DAY, expires: ago(3 * DAY), count: 7, last: 4 * DAY, token: 'demo-link-team-offsite-photo', state: 'expired' },
  { id: U(305), doc: F['Maple Street Bakery contract'], created: 19 * DAY, expires: ahead(11 * DAY), revoked: 8 * DAY, count: 1, last: 17 * DAY, token: 'demo-link-maple-street-contract', state: 'revoked' },
];
const FOLDER_LINKS = [
  { id: U(351), lib: 'client', path: 'Northfield Clinic/Site photos', docs: [F['Reception'].id, F['Waiting room'].id], created: 5 * DAY, expires: ahead(25 * DAY), opened: 4 * DAY, count: 4, last: 2 * DAY, token: 'demo-folder-northfield-site-photos', state: 'active', serving: 2 },
  { id: U(352), lib: 'client', path: 'Maple Street Bakery', docs: [F['Menu redesign'].id, F['Logo concepts'].id], created: 9 * DAY, expires: ahead(21 * DAY), recipient: 'hello@maple-street-bakery.example', live: true, allow_upload: true, uploads: 1, opened: 8 * DAY, count: 5, last: 1 * DAY, token: 'demo-folder-maple-street-bakery', state: 'active', serving: 2 },
];
function linkOut(l) {
  const f = l.doc;
  return {
    id: l.id, document_id: f.id, expires_at: l.expires, revoked_at: l.revoked ? ago(l.revoked) : null, created_at: ago(l.created), created_by_email: ME.email,
    recipient_email: l.recipient || null, require_signin: false, opened_at: l.opened ? ago(l.opened) : null, allow_upload: !!l.allow_upload,
    last_accessed_at: l.last ? ago(l.last) : null, access_count: l.count || 0, has_password: !!l.password, url: null,
    document_name: f.name, name_hidden: false, document_deleted: false, library_id: f.library_id, library_name: libById(f.library_id).name,
    created_by_me: true, state: l.state, paused_reason: null,
  };
}
function folderLinkOut(l) {
  return {
    id: l.id, folder_path: l.path, file_count: l.docs.length, expires_at: l.expires, revoked_at: null, created_at: ago(l.created), created_by_email: ME.email,
    last_accessed_at: l.last ? ago(l.last) : null, access_count: l.count || 0, has_password: !!l.password, recipient_email: l.recipient || null, live: !!l.live,
    require_signin: false, opened_at: l.opened ? ago(l.opened) : null, allow_upload: !!l.allow_upload, upload_count: l.uploads || 0, url: null,
    library_name: libById(LIB[l.lib]).name, created_by_me: true, state: l.state, serving: l.state === 'active' ? l.serving : 0, paused_reason: null,
  };
}

// ─── library and folder shares (Client Projects is Jordan's and shared) ───
const GROUPS = [
  { id: U(501), name: 'Client services', owner: 'jordan', created_at: ago(200 * DAY), members: ['jordan', 'priya', 'sam'] },
  { id: U(502), name: 'Northfield project', owner: 'jordan', created_at: ago(20 * DAY), members: ['jordan', 'sam', 'elena', 'dana'] },
  { id: U(503), name: 'Design team', owner: 'priya', created_at: ago(300 * DAY), members: ['priya', 'jordan', 'elena'] },
  { id: U(504), name: 'Everyone at Acme', owner: 'elena', created_at: ago(600 * DAY), members: ['elena', 'jordan', 'priya', 'marcus', 'sam'] },
];
const LIB_SHARES = [
  { id: U(601), lib: 'client', folder: '', who: 'priya', permission: 'write', by: 'jordan', at: 300 * DAY },
  { id: U(602), lib: 'client', folder: '', who: 'sam', permission: 'read', by: 'jordan', at: 120 * DAY },
  { id: U(603), lib: 'client', folder: 'Northfield Clinic', group: U(502), permission: 'write', by: 'jordan', at: 19 * DAY },
];
function libShareOut(s) {
  const g = s.group ? GROUPS.find(x => x.id === s.group) : null;
  const email = s.who ? PEOPLE[s.who].email : null;
  return {
    id: s.id, library_id: LIB[s.lib], folder_path: s.folder, subject_type: g ? 'group' : 'user', subject_email: email,
    group: g ? { id: g.id, name: g.name, owner_email: PEOPLE[g.owner].email, member_count: g.members.length } : null,
    permission: s.permission, granted_by_email: PEOPLE[s.by].email, created_at: ago(s.at), updated_at: ago(s.at),
    account: g ? null : 'ok', folder_present: true, folder_state: null,
  };
}

// ─── notifications ───
const NOTIFS = [
  [25 * MIN, false, 'upload_received', `${PEOPLE.dana.email} sent you a file`, '"Intake form - signed.pdf" · via your exchange link', 'document', F['Intake form - signed'].id],
  [3 * HOUR, false, 'upload_received', 'Priya Shah uploaded 2 files to Autumn 2026 (Marketing)', 'Hero banner.jpg, Social calendar.xlsx', 'library', LIB.marketing, 'Campaigns/Autumn 2026'],
  [5 * HOUR, false, 'document_edited', 'A file you follow was edited: Budgets/FY2026 budget.xlsx', '"Budgets/FY2026 budget.xlsx"', 'document', F['FY2026 budget'].id],
  [26 * HOUR, true, 'share_opened', `${PEOPLE.dana.email} opened your file`, '"Northfield Clinic proposal.docx" · via their link', 'document', F['Northfield Clinic proposal'].id],
  [2 * DAY + 3 * HOUR, true, 'share_granted', `${PEOPLE.elena.email} shared a file with you`, '"Office move plan.pdf" · read access', 'document', F['Office move plan'].id],
  [4 * DAY, true, 'share_downloaded', 'Your shared file was downloaded', '"Brand/Brand guidelines.pdf" · via share link', 'document', F['Brand guidelines'].id],
  [6 * DAY, true, 'upload_received', 'Sam Okafor uploaded a folder (2 files) to Northfield Clinic (Client Projects)', 'Reception.jpg, Waiting room.jpg', 'library', LIB.client, 'Northfield Clinic'],
  [9 * DAY, true, 'share_granted', `${PEOPLE.marcus.email} shared a library with you`, 'the library "Finance" · Read-only', 'library', LIB.finance],
  [12 * DAY, true, 'share_granted', `${PEOPLE.elena.email} shared a folder with you`, 'the folder "Onboarding" in Operations · Read-only', 'library', LIB.ops, 'Onboarding'],
  [16 * DAY, true, 'share_opened', `${PEOPLE.priya.email} opened your shared library`, 'the library · first file opened: "Kickoff agenda.docx"', 'library', LIB.client],
].map(([age, read, type, title, body, rt, rid, rp], i) => ({ id: U(401 + i), type, title, body, ref_type: rt, ref_id: rid, ref_path: rp || null, read_at: read ? ago(age - 10 * MIN) : null, created_at: ago(age) }));

// ─── connections ───
const CONNECTORS = [
  { id: U(801), name: 'Acme Intranet', kind: 'sharepoint', label: 'SharePoint document library', readOnly: false, caps: { write: true, remove: true, mkdir: true, range: true, move: true, share: true, invite: true }, delegated: false },
  { id: U(802), name: 'Office file server', kind: 'smb', label: 'SMB / Windows file share', readOnly: false, caps: { write: true, remove: true, mkdir: true, range: true, move: true }, delegated: false },
];
const SP = 'https://intranet.acme.example/sites/intranet/Shared%20Documents/';
const TREE = {
  [U(801)]: {
    '': [['Company news', 'dir', null, 3], ['HR', 'dir', null, 12], ['Policies', 'dir', null, 30], ['Templates', 'dir', null, 45], ['Holiday calendar 2026.xlsx', 'file', 31 * KB, 60], ['Org chart.pdf', 'file', 410 * KB, 21], ['Staff handbook.docx', 'file', 1.2 * MB, 33]],
    'Policies': [['Data protection policy.pdf', 'file', 320 * KB, 40], ['Remote work policy.docx', 'file', 64 * KB, 75], ['Security basics.pdf', 'file', 210 * KB, 30]],
    'Templates': [['Letterhead.docx', 'file', 88 * KB, 120], ['Proposal cover.pptx', 'file', 2.4 * MB, 90], ['Timesheet.xlsx', 'file', 22 * KB, 200]],
    'HR': [['Benefits overview.pdf', 'file', 540 * KB, 12], ['Leave request form.docx', 'file', 30 * KB, 150]],
    'Company news': [['September update.docx', 'file', 120 * KB, 3], ['Summer party photos.pdf', 'file', 4.1 * MB, 50]],
  },
  [U(802)]: {
    '': [['Scans', 'dir', null, 1], ['Projects', 'dir', null, 2], ['Shared templates', 'dir', null, 64], ['Finance archive', 'dir', null, 200], ['Printer instructions.pdf', 'file', 180 * KB, 300], ['Office floor plan.pdf', 'file', 1.4 * MB, 14]],
    'Scans': [['Scan 2026-09-28 0912.pdf', 'file', 820 * KB, 1], ['Scan 2026-09-24 1540.pdf', 'file', 640 * KB, 5], ['Signed NDA - Harbor Point.pdf', 'file', 290 * KB, 14]],
    'Projects': [['Northfield Clinic', 'dir', null, 2], ['Maple Street Bakery', 'dir', null, 11], ['Riverside Library', 'dir', null, 140]],
    'Shared templates': [['Invoice template.xlsx', 'file', 28 * KB, 90], ['Meeting notes template.docx', 'file', 19 * KB, 90]],
    'Finance archive': [['2024', 'dir', null, 300], ['2025', 'dir', null, 200]],
  },
};

// ─── helpers ───
const file = (p) => (fs.existsSync(p) ? p : null);
const assetFile = (f) => (f && f._asset ? file(path.join(ASSETS, 'files', `${f._asset}.${extOf(f.name)}`)) : null);
const thumbFile = (f) => (f && f._asset ? file(path.join(ASSETS, 'thumbs', `${f._asset}.webp`)) : null);
const noContent = (res) => { res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); };
const notFound = (msg = 'Document not found') => ({ __status: 404, body: { error: msg } });
const visibleFiles = (lib) => FILES.filter(f => !lib || f.library_id === lib);
const newId = () => U(9000 + Math.floor(Math.random() * 999));
const token = () => Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
function streamAnswer(res, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
  for (const part of text.match(/.{1,40}(\s|$)/g) || [text]) res.write(`data: ${JSON.stringify({ text: part })}\n\n`);
  res.write('data: [DONE]\n\n'); res.end();
}

// ─── who has access (lib/accessKeys shapes, worked out for this small world) ───
const ADMINS = { count: 1 };
const RANK = { read: 1, write: 2, admin: 3 };
const maxLevel = (a, b) => ((RANK[a] || 0) >= (RANK[b] || 0) ? a : b) || null;
const shareRelation = (door, folder) => (door.kind === 'library' ? (folder ? 'inside' : 'door') : door.kind === 'file' ? 'above' : !folder ? 'above' : folder === door.path ? 'at' : folder.length < door.path.length ? 'above' : 'inside');
function reachesDoor(door, s) { // does this share open the door (or something inside it)?
  if (s.lib !== door.lib) return false;
  if (!s.folder) return true;
  const target = door.kind === 'file' ? door.name : door.path;
  if (door.kind === 'library') return true; // inside
  return target === s.folder || target.startsWith(s.folder + '/') || (door.kind === 'folder' && s.folder.startsWith(door.path + '/'));
}
function peopleForDoor(door) {
  const lib = libById(LIB[door.lib]);
  const owner = PEOPLE[lib.owner];
  const map = new Map();
  const add = (p, reason) => {
    if (!p || !p.id) return;
    if (!map.has(p.id)) map.set(p.id, { p, reasons: [] });
    map.get(p.id).reasons.push(reason);
  };
  add(owner, { key: 'owner', kind: 'owner', relation: 'door', level: 'admin', permission: null, via_group: null, folder_path: null, granted_by: null, granted_at: null });
  const keys = [];
  for (const s of LIB_SHARES.filter(x => reachesDoor(door, x))) {
    const kind = s.folder ? 'folder_share' : 'library_share';
    const key = `${s.folder ? 'fs' : 'ls'}:${s.id}`;
    const relation = shareRelation(door, s.folder);
    const g = s.group ? GROUPS.find(x => x.id === s.group) : null;
    const reason = { key, kind, relation, level: s.permission, permission: s.permission, via_group: g ? { id: g.id, name: g.name } : null, folder_path: s.folder, granted_by: person(PEOPLE[s.by].email), granted_at: ago(s.at) };
    const members = g ? g.members.map(m => PEOPLE[m]) : [PEOPLE[s.who]];
    members.forEach(m => add(m, reason));
    keys.push({ s, key, kind, relation, g, members });
  }
  return { owner, map, keys };
}
function doorPeople(map, ownerId) {
  return [...map.values()].filter(({ p }) => p.id).map(({ p, reasons }) => {
    const opening = reasons.filter(r => r.relation !== 'inside');
    const level = opening.reduce((m, r) => maxLevel(m, r.level), null);
    return { ref: `u:${p.id}`, user_id: p.id, email: p.email, name: p.name, level, effective: level, view_only: false, is_owner: p.id === ownerId,
      same_address_accounts: 1, partial: !level, ways_in: new Set(reasons.map(r => r.key)).size, reasons };
  }).sort((a, b) => (Number(b.is_owner) - Number(a.is_owner)) || ((RANK[b.level] || 0) - (RANK[a.level] || 0)) || a.name.localeCompare(b.name));
}
function doorKeys(door, owner, people, keyRows, extra = []) {
  const admits = (ref) => people.filter(p => p.reasons.some(r => r.key === ref)).map(p => p.ref);
  const impact = (ref) => ({ lose: admits(ref).filter(r => { const p = people.find(x => x.ref === r); return p.reasons.every(x => x.key === ref || x.relation === 'inside'); }), keep: [], unknown: [], admins_unaffected: 0 });
  const keys = [
    { ref: 'owner', kind: 'owner', id: null, folder_path: null, relation: 'door', subject: { type: 'user', email: owner.email, account: 'ok' }, permission: null, granted_by: null, granted_at: null, waiting: null, waiting_count: 0, change_here: false, can_remove: false, impact: null, impact_if_read: null, files_impact: null, admits: [`u:${owner.id}`], admits_admins: 0 },
    { ref: 'admins', kind: 'admin', id: null, folder_path: null, relation: 'door', subject: null, permission: null, granted_by: null, granted_at: null, waiting: null, waiting_count: 0, change_here: false, can_remove: false, impact: null, impact_if_read: null, files_impact: null, admits: [], admits_admins: 1 },
  ];
  for (const k of keyRows) {
    const waiting = k.g ? k.g.members.filter(m => !PEOPLE[m].id).map(m => ({ email: PEOPLE[m].email, why: 'no_account' })) : null;
    keys.push({
      ref: k.key, kind: k.kind, id: k.s.id, folder_path: k.s.folder, relation: k.relation,
      subject: k.g ? { type: 'group', id: k.g.id, name: k.g.name, owner_email: PEOPLE[k.g.owner].email, member_count: k.g.members.length, viewable: true } : { type: 'user', email: PEOPLE[k.s.who].email, name: PEOPLE[k.s.who].name, account: 'ok' },
      permission: k.s.permission, granted_by: person(PEOPLE[k.s.by].email), granted_at: ago(k.s.at), waiting, waiting_count: waiting ? waiting.length : 0,
      change_here: k.relation === 'door' || k.relation === 'at', can_remove: true,
      impact: impact(k.key), impact_if_read: k.s.permission === 'write' ? { lose: [], keep: admits(k.key).map(r => ({ ref: r, before: 'write', after: 'read', via: [] })), unknown: [], admins_unaffected: 0 } : null, files_impact: null,
      admits: admits(k.key), admits_admins: 0,
    });
  }
  return keys.concat(extra);
}
function doorLinks(door) {
  const out = [];
  for (const l of LINKS.filter(x => x.state === 'active' || x.state === 'paused')) {
    const f = l.doc;
    const inDoor = door.kind === 'file' ? f.id === door.id : f.library_id === LIB[door.lib] && (!door.path || f.name.startsWith(door.path + '/'));
    if (!inDoor) continue;
    const cut = f.name.lastIndexOf('/');
    out.push({ ref: `lk:${l.id}`, kind: 'file', id: l.id, document_id: f.id, name: f.name.slice(cut + 1), folder_path: cut < 0 ? '' : f.name.slice(0, cut), file_count: 1, files_here: 1, serving: 1,
      created_by: { user_id: ME.id, email: ME.email, name: ME.name }, created_by_me: true, recipient_email: l.recipient || null, require_signin: false, opened_at: l.opened ? ago(l.opened) : null,
      expires_at: l.expires, has_password: !!l.password, allow_upload: !!l.allow_upload, access_count: l.count || 0, last_accessed_at: l.last ? ago(l.last) : null, state: 'active', paused_reason: null, can_revoke: true });
  }
  if (door.kind !== 'file') {
    for (const l of FOLDER_LINKS.filter(x => LIB[x.lib] === LIB[door.lib] && (!door.path || x.path === door.path || x.path.startsWith(door.path + '/')))) {
      out.push({ ref: `fl:${l.id}`, kind: 'folder', id: l.id, document_id: null, name: l.path.split('/').pop(), folder_path: l.path, file_count: l.docs.length, files_here: l.docs.length, serving: l.serving,
        created_by: { user_id: ME.id, email: ME.email, name: ME.name }, created_by_me: true, recipient_email: null, expires_at: l.expires, has_password: false, allow_upload: false,
        access_count: l.count || 0, last_accessed_at: l.last ? ago(l.last) : null, state: 'active', paused_reason: null, can_revoke: true });
    }
  }
  return out;
}
function yourReasons(lib, f) { // Jordan's own way in, as the "you" block shows it
  const l = libById(lib);
  if (l.owner === 'jordan') return { level: 'admin', reasons: [{ key: 'owner', kind: 'owner', relation: 'door', level: 'admin', permission: null, via_group: null, folder_path: null, granted_by: null, granted_at: null }] };
  if (l.my_access === 'rw') return { level: 'write', reasons: [{ key: 'ls:' + U(611), kind: 'library_share', relation: f ? 'above' : 'door', level: 'write', permission: 'write', via_group: null, folder_path: '', granted_by: person(PEOPLE[l.owner].email), granted_at: ago(360 * DAY) }] };
  if (l.my_access === 'r') return { level: 'read', reasons: [{ key: 'ls:' + U(612), kind: 'library_share', relation: f ? 'above' : 'door', level: 'read', permission: 'read', via_group: null, folder_path: '', granted_by: person(PEOPLE[l.owner].email), granted_at: ago(9 * DAY) }] };
  if (f && f.id === DIRECT.file.id) return { level: 'read', reasons: [{ key: 'fg:' + DIRECT.grant, kind: 'file_grant', relation: 'at', level: 'read', permission: 'read', via_group: null, folder_path: null, granted_by: person(DIRECT.by.email), granted_at: DIRECT.at }] };
  if (f && f.name.startsWith('Onboarding/')) return { level: 'read', reasons: [{ key: 'fs:' + U(613), kind: 'folder_share', relation: 'above', level: 'read', permission: 'read', via_group: null, folder_path: 'Onboarding', granted_by: person(PEOPLE.elena.email), granted_at: ago(12 * DAY) }] };
  return { level: null, reasons: [] };
}
function fileDoor(f) {
  const l = libById(f.library_id);
  const owner = PEOPLE[l.owner];
  const cut = f.name.lastIndexOf('/');
  const mine = yourReasons(f.library_id, f);
  const out = {
    door: { kind: 'file', file: { id: f.id, name: f.name.slice(cut + 1), folder: cut < 0 ? '' : f.name.slice(0, cut), library: { id: l.id, name: l.name, owner_email: owner.email }, library_content: true,
      added_by: { email: f.uploaded_by_email, name: f.uploaded_by_name || nameOf(f.uploaded_by_email), can_get_in: managed(f) ? true : null } } },
    can_see_keys: managed(f), generated_at: new Date().toISOString(),
    you: { level: mine.level, effective: mine.level, view_only: false, reasons: mine.reasons, owner: { email: owner.email, name: owner.name } },
  };
  if (!managed(f)) return out;
  const door = { kind: 'file', lib: f._lib, id: f.id, name: f.name };
  const { map, keys } = peopleForDoor(door);
  const people = doorPeople(map, owner.id);
  Object.assign(out, { library_detail: 'full', hidden_note: null, people, keys: doorKeys(door, owner, people, keys), links: doorLinks(door), admins: ADMINS });
  return out;
}
function libraryDoor(l, folder) {
  const owner = PEOPLE[l.owner];
  const lib = Object.keys(LIB).find(k => LIB[k] === l.id);
  const mine = yourReasons(l.id, null);
  const inside = l.my_folders.map(x => ({ path: x.path, level: x.level === 'rw' ? 'write' : 'read' }));
  const out = {
    door: { kind: folder ? 'folder' : 'library', library: { id: l.id, name: l.name, owner: { user_id: owner.id, email: owner.email, name: owner.name } }, path: folder || '', name: folder ? folder.split('/').pop() : l.name },
    can_see_keys: l.can_manage, generated_at: new Date().toISOString(),
    you: { level: mine.level, effective: mine.level, view_only: false, reasons: mine.reasons, inside: { folders: inside, files: l.id === LIB.ops ? 1 : 0 }, listed_because: null, owner: { email: owner.email, name: owner.name } },
  };
  if (!l.can_manage) return out;
  const door = { kind: folder ? 'folder' : 'library', lib, path: folder || '' };
  const { map, keys } = peopleForDoor(door);
  const people = doorPeople(map, owner.id);
  Object.assign(out, { people, keys: doorKeys(door, owner, people, keys), links: doorLinks(door), admins: ADMINS });
  return out;
}

// ─── shared with me ───
function sharedWithMe() {
  const stats = (lib, pfx = '') => { const fs_ = FILES.filter(f => f._lib === lib && !f.name.endsWith('.keep') && (!pfx || f.name.startsWith(pfx + '/'))); return { files: fs_.length, bytes: fs_.reduce((a, f) => a + f.size, 0), updated_at: fs_.reduce((m, f) => (f.created_at > m ? f.created_at : m), '') || null }; };
  const libRow = (lib, level, by, at) => { const l = libById(LIB[lib]); const o = PEOPLE[l.owner]; return { library: { id: l.id, name: l.name, owner: person(o.email) }, level, shares: [{ share_id: U(610 + level.length), via_group: null, permission: level, granted_by: person(by.email), granted_at: ago(at) }], ...stats(lib), effective: level, view_only: false }; };
  const ops = libById(LIB.ops);
  return {
    email_verified: true, is_admin: false,
    libraries: [libRow('finance', 'read', PEOPLE.marcus, 9 * DAY), libRow('marketing', 'write', PEOPLE.priya, 360 * DAY)],
    folders: [{ library: { id: ops.id, name: ops.name, owner: person(PEOPLE.elena.email) }, path: 'Onboarding', level: 'read', shares: [{ share_id: U(613), via_group: null, permission: 'read', granted_by: person(PEOPLE.elena.email), granted_at: ago(12 * DAY) }], ...stats('ops', 'Onboarding'), effective: 'read', view_only: false, name: 'Onboarding', also_whole_library: false }],
    files: [{ document: { id: DIRECT.file.id, name: 'Office move plan.pdf', folder: '', size: DIRECT.file.size, created_at: DIRECT.file.created_at, library: { id: ops.id, name: ops.name } },
      level: 'read', effective: 'read', grant_id: DIRECT.grant, permission: 'read', granted_by: person(DIRECT.by.email), granted_at: DIRECT.at, owner: person(PEOPLE.elena.email) }],
    truncated: { files: false },
  };
}

// ─── search (names and a little indexed text) ───
const TEXT = {
  'Northfield Clinic proposal': 'online intake forms, booking connected to scheduling, searchable archive of scanned records, $52,000',
  'Northfield Clinic service agreement': 'service agreement fees and payment, confidentiality of patient information, 30 days written notice',
  'Q3 budget': 'contractors software travel client events training hardware printing variance',
  'Brand guidelines': 'logo clear space, colour palette navy coral teal, typography, voice and tone',
  'Expense policy': 'hotel per night $180, meals $60 per day, claim within 30 days, receipts',
  'Meeting notes': 'kick-off 6 October, autumn campaign, office move 13 November',
  'Monthly report - August': 'billable hours 612, on-time delivery 94%, client score 4.6',
  'Office move plan': 'move date Friday 13 November, Harbor Road studio, label your boxes',
};
function search(q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return [];
  const words = s.split(/\s+/).filter(Boolean);
  const out = [];
  for (const f of FILES) {
    if (f.name.endsWith('.keep')) continue;
    const base = f.name.split('/').pop().replace(/\.[^.]+$/, '');
    const text = TEXT[base] || '';
    const hay = (f.name + ' ' + text).toLowerCase();
    if (!words.every(w => hay.includes(w))) continue;
    let headline = '';
    const hit = words.find(w => text.toLowerCase().includes(w));
    if (hit) { const i = text.toLowerCase().indexOf(hit); headline = text.slice(Math.max(0, i - 40), i) + '<<' + text.slice(i, i + hit.length) + '>>' + text.slice(i + hit.length, i + hit.length + 60); }
    out.push({ ...pub(f), search_headline: headline, search_rank: hit ? 0.6 : 0.1 });
  }
  return out.sort((a, b) => b.search_rank - a.search_rank);
}

// ─── routes ───
const CONFIG = { keycloakUrl: 'http://127.0.0.1', keycloakRealm: 'demo', keycloakClientId: 'demo', version: 'v2026.09.19.005', editingEnabled: true, defaultOfficeOpen: 'preview', loginIdps: ['microsoft'], brand: { name: 'Acme Co', logo: '', scheme: 'ledger' }, maxUploadMb: 2048, maxUploadFiles: 1000, setupRequired: false };
// The app draws its first view before it has asked who you are and which libraries you have
// (index.html _afterLogin). A real server answers the file list more slowly than those, so the
// first view already knows them; an instant fixture would win the race and draw a Home with
// "No libraries of your own yet" and every file counted as shared. So the big lists wait a beat.
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const LIST_LATENCY = 450;
exports.routes = {
  // who am I, and what is this place
  // The capture runner seeds storage from a page at /__blank, which is this same SPA. With the
  // previous shot's session still in storage it would sign in there and write its own library
  // choice over the one the shot asked for. Refusing it the config keeps that page inert.
  'GET /api/config': ({ req, res }) => {
    if (/\/__blank$/.test(String(req.headers.referer || ''))) { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('storage seeding page'); return undefined; }
    return CONFIG;
  },
  'GET /api/auth/me': { id: ME.id, email: ME.email, role: ME.role, name: ME.name, display_name: ME.name, avatar: null },
  'GET /api/auth/profile': { display_name: ME.name, avatar: '' },
  'PUT /api/auth/profile': ({ body }) => ({ display_name: body.display_name ?? ME.name, avatar: body.avatar || '' }),
  'GET /api/preferences': { pinnedLibraries: [LIB.client, LIB.marketing], favoriteFiles: [F['Northfield Clinic proposal'].id, F['Brand guidelines'].id, F['Q3 budget'].id, F['Team offsite photo'].id] },
  'PUT /api/preferences': ({ body }) => ({ ok: true, pinnedLibraries: body.pinnedLibraries || [], favoriteFiles: body.favoriteFiles || [] }),
  'GET /api/security/status': () => ({ level: 'ok', configured: true, firewall: 'UFW', recentConnections: 0, window: '15 minutes', message: 'No blocked connection attempts in the last 15 minutes.', updatedAt: ago(2 * MIN) }),
  'GET /api/version/check': { current: 'v2026.09.19.005', latest: 'v2026.09.19.005', behind: 0 },
  'GET /api/license': { updatesEntitled: false },
  'GET /api/webrtc/ice': { iceServers: [{ urls: ['stun:turn.acme.example:3478'] }], screenconnectUrl: '' },
  // Fictional model names on purpose: the guide's screenshots must never show a real AI
  // vendor's product name (the scope button in the top bar renders this as "Auto · <model>").
  'GET /api/ai/models': { active: 'depot:assistant', models: ['assistant-large', 'assistant', 'assistant-mini'].map(id => ({ provider: 'depot', id, label: id.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' '), group: 'Depot AI' })) },
  'PUT /api/ai/active': ({ body }) => ({ active: body.model || 'depot:assistant' }),
  'POST /api/ai/query': ({ res, body }) => streamAnswer(res, `Here is what I found in your files about "${String(body.question || '').slice(0, 80)}".\n\nThe Northfield Clinic proposal sets out a 16-week project: online intake forms first (weeks 3 to 6), then booking connected to the clinic's scheduling system, then a searchable records archive and staff training. The total is $52,000, paid in four milestones.\n\nSources: Northfield Clinic proposal.docx, Northfield Clinic service agreement.pdf`),
  'POST /api/files/ask': ({ res }) => streamAnswer(res, 'Based on the files you selected: the project starts with a kick-off at the clinic on 6 October, and the online forms go live in week 6. Dana Whitfield signs for Northfield Clinic; Jordan Lee signs for Acme Co.'),

  // libraries
  'GET /api/libraries': () => LIBRARIES.map(libOut),
  'POST /api/libraries': ({ body }) => ({ id: U(299), name: String(body.name || 'New library'), created_by_email: ME.email, owner_id: ME.id, owner_email: ME.email, created_at: new Date().toISOString() }),
  'PATCH /api/libraries/:id': ({ params, body }) => ({ ...libOut(libById(params.id) || LIBRARIES[0]), name: body.name }),
  'GET /api/libraries/:id/shares': ({ params }) => {
    const l = libById(params.id);
    if (!l || !l.can_manage) return { __status: 403, body: { error: 'Only the library owner or an admin can share it' } };
    const o = PEOPLE[l.owner];
    return { library: { id: l.id, name: l.name, owner_id: o.id, owner_email: o.email }, shares: LIB_SHARES.filter(s => LIB[s.lib] === l.id).map(libShareOut) };
  },
  'POST /api/libraries/:id/shares': ({ params, body }) => ({ share: { id: newId(), library_id: params.id, folder_path: body.folder_path || '', subject_type: body.group_id ? 'group' : 'user', subject_email: body.email || null, group: null, permission: body.permission || 'read', granted_by_email: ME.email, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), account: 'ok', folder_present: true }, emailed: true }),
  'PUT /api/libraries/:id/shares/:shareId': ({ body }) => ({ ok: true, permission: body.permission }),
  'DELETE /api/libraries/:id/shares/:shareId': { ok: true },
  'POST /api/libraries/:id/shares/:shareId/resend': { ok: true, sent: true },

  // who has access, shared with me
  'GET /api/access/shared-with-me': () => sharedWithMe(),
  'GET /api/access/files/:id': ({ params }) => { const f = FILES.find(x => x.id === params.id); return f ? fileDoor(f) : notFound(); },
  'GET /api/access/libraries/:id': ({ params, query }) => { const l = libById(params.id); return l ? libraryDoor(l, query.folder || '') : notFound('Library not found'); },
  'POST /api/access/folder-preview': ({ body }) => ({ previews: (body.ops || []).map(op => ({ op: op.op, lose_visible: true, gain_visible: true, lose: [], changed: [], gain: [], admins_unaffected: 0, shares_moving: 0, shares_ending: [], fingerprint: 'sha256:demo', generated_at: new Date().toISOString() })) }),

  // files: lists
  'GET /api/files': async ({ query }) => { await wait(LIST_LATENCY); return visibleFiles(query.library || null).map(pub); },
  'GET /api/files/home-stats': { usedBytes: 186 * 1024 ** 3, totalBytes: 480 * 1024 ** 3, uploads14: [1, 0, 2, 3, 0, 1, 2, 4, 1, 0, 3, 2, 2, 5], activeUsers: 1 },
  'GET /api/files/media-ticket': () => ({ ticket: 'demo-media-ticket', expiresAt: ahead(HOUR) }),
  // Quick access (the rail) lists these. Kept to short names on purpose: the rail is a grid
  // whose column grows with a long unbroken name (no minmax(0,1fr)), which pushes the rail's
  // right edge, pins and heading out of view. A real long name does the same in the real app.
  'GET /api/files/recent': () => [
    [F['Meeting notes'], 35 * MIN], [F['Hero banner'], 2 * HOUR], [F['Q3 budget'], 3 * HOUR], [F['Kickoff agenda'], 22 * HOUR],
    [F['Brand guidelines'], 27 * HOUR], [F['Floor plan'], 2 * DAY], [F['Office move plan'], 2 * DAY], [F['FY2026 budget'], 4 * DAY],
  ].map(([f, t]) => ({ id: f.id, name: f.name, size: f.size, mime_type: f.mime_type, created_at: f.created_at, uploaded_by: f.uploaded_by, uploaded_by_email: f.uploaded_by_email, library_id: f.library_id, opened_at: ago(t) })),
  'GET /api/files/trash': async () => { await wait(LIST_LATENCY); return TRASH; },
  'GET /api/files/search': ({ query }) => search(query.q),
  'GET /api/files/follows': { ids: [F['Northfield Clinic proposal'].id, F['FY2026 budget'].id, F['Brand guidelines'].id] },
  'GET /api/files/watch/state': ({ query }) => {
    const l = libById(query.library_id);
    const prefs = query.library_id === LIB.marketing ? [{ folder_path: 'Campaigns/Autumn 2026', enabled: true }] : query.library_id === LIB.client ? [{ folder_path: 'Archive', enabled: false }] : [];
    return { isOwner: !!l && l.owner === 'jordan', prefs };
  },
  'GET /api/files/watch': ({ query }) => ({ notify: libById(query.library_id)?.owner === 'jordan' || (query.library_id === LIB.marketing && String(query.folder_path || '').startsWith('Campaigns/Autumn 2026')) }),
  'POST /api/files/watch': ({ body }) => ({ notify: body.notify !== false }),
  'GET /api/files/shares': () => ({ scope: 'mine', shares: LINKS.map(linkOut), folder_links: FOLDER_LINKS.map(folderLinkOut) }),

  // files: folders (literal paths, before the /:id routes below)
  'GET /api/files/folder/links': ({ query }) => ({ shares: FOLDER_LINKS.filter(l => l.path === query.path).map(folderLinkOut) }),
  'POST /api/files/folder/links': ({ body }) => { const t = token(); return { share: { id: newId(), folder_path: body.path || body.folderPath || '', file_count: 3, expires_at: body.neverExpires ? null : ahead((+body.expiresInDays || 7) * DAY), revoked_at: null, created_at: new Date().toISOString(), created_by_email: ME.email, access_count: 0, has_password: !!body.password, live: false, url: `${SITE}/f/${t}` }, url: `${SITE}/f/${t}` }; },
  'DELETE /api/files/folder/links/:shareId': { ok: true },
  'POST /api/files/folder/send': ({ body }) => ({ results: (body.recipients || body.emails || []).map(to => ({ to, kind: 'link', sent: true, url: `${SITE}/f/${token()}` })), hasPassword: !!body.password }),
  'GET /api/files/folder/members': { grants: [] },
  'DELETE /api/files/folder/members': { ok: true },
  'POST /api/files/folder': ({ body }) => ({ ok: true, path: body.path || body.name || 'New folder' }),
  'POST /api/files/folder/rename': ({ body }) => ({ ok: true, moved: 3, path: body.newPath || body.name }),
  'POST /api/files/folder/delete': { ok: true, deleted: 3, undo: { token: 'demo-undo' } },
  'POST /api/files/folder/restore': { ok: true, restored: 3 },
  'POST /api/files/folder/move': { ok: true, moved: 3 },
  'POST /api/files/folder/reparent': { ok: true, moved: 3 },
  'POST /api/files/folder/copy': { ok: true, copied: 3 },
  'POST /api/files/folder/zip-ticket': { ticket: 'demo-zip', url: '/demo-assets/files/northfield-proposal.docx' },
  'POST /api/files/library-transfer': ({ body }) => ({ ok: true, moved: (body.ids || []).length, copied: 0, results: (body.ids || []).map(id => ({ id, ok: true })) }),
  'POST /api/files/create': ({ body }) => { const f = { ...pub(F['Meeting notes']), id: newId(), name: body.name || 'Untitled.md', size: 0, created_at: new Date().toISOString() }; return { ...f, document: f }; },
  'POST /api/files/upload-stream': ({ query }) => ({ id: newId(), name: query.displayName || 'Upload', size: 0 }),
  'POST /api/files/uploads': ({ body }) => { const chunk = +body.chunkSize || 8 * MB; return { session: { id: 'demo-upload-' + token(), status: 'active', chunkSize: chunk, totalChunks: Math.max(1, Math.ceil((+body.size || 1) / chunk)), receivedChunks: [] } }; },
  'GET /api/files/uploads/:sessionId': { __status: 404, body: { error: 'Upload not found' } },
  'PUT /api/files/uploads/:sessionId/chunks/:index': ({ params }) => ({ session: { id: params.sessionId, status: 'active' } }),
  'POST /api/files/uploads/:sessionId/complete': () => ({ ok: true, document: { id: newId() } }),
  'DELETE /api/files/uploads/:sessionId': { ok: true },

  // files: one file
  'GET /api/files/:id/thumbnail': ({ params, res }) => { const p = thumbFile(fileById(params.id)); if (!p) return noContent(res); return { __file: p, type: 'image/webp' }; },
  'GET /api/files/:id/url': ({ params }) => { const f = fileById(params.id); if (!f) return notFound(); return { url: `/demo-assets/files/${f._asset || 'missing'}.${extOf(f.name)}`, name: f.name }; },
  'GET /api/files/:id/office': ({ params }) => { const f = fileById(params.id); return f ? { editUrl: null, ext: extOf(f.name) } : notFound(); },
  'POST /api/files/:id/open': { ok: true },
  'POST /api/files/:id/follow': ({ body }) => ({ following: body.follow !== false }),
  'GET /api/files/:id/shares': ({ params }) => {
    const f = fileById(params.id);
    if (!f) return notFound();
    if (!writable(f)) return { __status: 403, body: { error: 'You need edit access to share this file' } };
    return { shares: LINKS.filter(l => l.doc.id === f.id).map(l => ({ ...linkOut(l), url: `${SITE}/s/${l.token}` })) };
  },
  'POST /api/files/:id/shares': ({ params, body }) => { const t = token(); return { share: { id: newId(), document_id: params.id, expires_at: body.neverExpires ? null : ahead((+body.expiresInDays || 7) * DAY), revoked_at: null, created_at: new Date().toISOString(), created_by_email: ME.email, recipient_email: null, require_signin: false, opened_at: null, allow_upload: false, last_accessed_at: null, access_count: 0, has_password: !!body.password, url: `${SITE}/s/${t}` } }; },
  'POST /api/files/:id/send': ({ params, body }) => {
    const f = fileById(params.id);
    const grant = f && managed(f);
    return { results: (body.recipients || []).map(to => { const inside = /@acme\.example$/i.test(to); return { to, kind: inside ? (grant ? 'granted' : 'signin_link') : 'link', permission: body.permission || 'read', sent: true, url: inside ? null : `${SITE}/s/${token()}` }; }), hasPassword: !!body.password };
  },
  'DELETE /api/files/:id/shares/:shareId': { ok: true },
  'POST /api/files/:id/access/resend': { ok: true, sent: true },
  'DELETE /api/files/:id/access/:grantId': { ok: true },
  'PUT /api/files/:id/rename': ({ params, body }) => { const f = fileById(params.id); return { ...(f ? pub(f) : {}), id: params.id, name: body.name }; },
  'PUT /api/files/:id/content': { ok: true },
  'DELETE /api/files/:id': { ok: true },
  'POST /api/files/:id/restore': { ok: true },

  // notifications
  'GET /api/notifications': () => ({ notifications: NOTIFS, unread: NOTIFS.filter(n => !n.read_at).length, enabled: true,
    email: { configured: true, events: { share_granted: true, share_opened: true, share_downloaded: false, upload_received: true, document_edited: false } } }),
  'POST /api/notifications/read': ({ body }) => ({ updated: body.all ? NOTIFS.filter(n => !n.read_at).length : (body.ids || []).length }),
  'PUT /api/notifications/pref': ({ body }) => ({ enabled: body.enabled !== false }),

  // groups
  'GET /api/groups': () => GROUPS.filter(g => g.members.includes('jordan') || g.owner === 'jordan').map(g => ({ id: g.id, name: g.name, owner_id: PEOPLE[g.owner].id, owner_email: PEOPLE[g.owner].email, created_at: g.created_at, member_count: g.members.length, is_member: g.members.includes('jordan'), can_manage: g.owner === 'jordan' })),
  'GET /api/groups/:id': ({ params }) => {
    const g = GROUPS.find(x => x.id === params.id); if (!g) return notFound('Group not found');
    const o = PEOPLE[g.owner];
    return g.owner === 'jordan'
      ? { id: g.id, name: g.name, owner_id: o.id, owner_email: o.email, created_by: o.id, created_by_email: o.email, created_at: g.created_at, updated_at: g.created_at, can_manage: true, share_count: LIB_SHARES.filter(s => s.group === g.id).length }
      : { id: g.id, name: g.name, owner_id: o.id, owner_email: o.email, created_at: g.created_at, can_manage: false };
  },
  'GET /api/groups/:id/members': ({ params }) => {
    const g = GROUPS.find(x => x.id === params.id); if (!g) return notFound('Group not found');
    return g.members.map((m, i) => { const p = PEOPLE[m]; return g.owner === 'jordan'
      ? { id: U(550 + i), member_email: p.email, added_by_email: PEOPLE[g.owner].email, created_at: g.created_at, display_name: p.id ? p.name : null, has_signed_in: !!p.id }
      : { member_email: p.email, display_name: p.name }; }).sort((a, b) => a.member_email.localeCompare(b.member_email));
  },
  'POST /api/groups': ({ body }) => ({ id: U(599), name: body.name, owner_id: ME.id, owner_email: ME.email, created_at: new Date().toISOString(), member_count: 1, is_member: true, can_manage: true }),
  'PUT /api/groups/:id': ({ body }) => ({ ok: true, name: body.name }),
  'DELETE /api/groups/:id': { ok: true },
  'POST /api/groups/:id/members': ({ body }) => ({ id: newId(), member_email: body.email, added_by_email: ME.email, created_at: new Date().toISOString(), display_name: nameOf(body.email), has_signed_in: !!byEmail(body.email)?.id }),
  'DELETE /api/groups/:id/members/:memberId': { ok: true },
  'PUT /api/groups/:id/owner': { ok: true },

  // connections
  'GET /api/connectors': { connectors: CONNECTORS },
  'GET /api/connectors/:id/browse': ({ params, query }) => {
    const tree = TREE[params.id]; if (!tree) return notFound('Connection not found');
    const p = String(query.path || '');
    const rows = tree[p] || [['Notes.docx', 'file', 24 * KB, 10], ['Photos', 'dir', null, 30]];
    return { path: p, entries: rows.map(([name, type, size, days]) => ({ name, path: p ? `${p}/${name}` : name, type, size: size == null ? null : Math.round(size), modified: ago(days * DAY + 3 * HOUR),
      openUrl: params.id === U(801) && type === 'file' ? SP + encodeURIComponent(p ? `${p}/${name}` : name) : null })) };
  },
  'POST /api/connectors/:id/folder': { ok: true },
  'POST /api/connectors/:id/move': { ok: true },
  'POST /api/connectors/:id/share': { url: 'https://intranet.acme.example/:w:/s/intranet/EdemoLink' },
  'POST /api/connectors/:id/invite': { ok: true },
  'DELETE /api/connectors/:id/file': { ok: true },
  'POST /api/connectors/:id/credentials': { ok: true },
  'DELETE /api/connectors/:id/credentials': { ok: true },

  // meetings
  'POST /api/meetings': ({ body }) => ({ sentCount: (body.attendees || []).length, skippedCount: 0, failedCount: 0 }),
};

// Presence over the demo WebSocket: Priya Shah and Marcus Chen are online.
const peer = (p) => ({ userId: p.id, name: p.name, email: p.email });
exports.presence = {
  onConnect: () => [{ type: 'welcome', self: peer(ME) }, { type: 'presence', users: [peer(ME), peer(PEOPLE.priya), peer(PEOPLE.marcus)] }],
  onMessage: (m) => (m && m.type === 'join' ? [{ type: 'room-peers', room: m.room, peers: [] }] : []),
};

// For shot files: bring the first view to the state a signed-in user actually sees. The app's
// first paint (rail heading, Files list, Quick access) happens before libraries, recent files and
// preferences load, and some views never refill Quick access ("Loading..."). Call it first in
// setup():  const { settle } = require('../demo/fixtures/base');  setup: async (page) => { await settle(page); ... }
// It re-applies the current #/ route (or Home) once everything has loaded. Not for connection
// (openMount) views: settle first, then open the connection.
exports.settle = async function settle(page, { wait: ms = 900 } = {}) {
  await page.eval(async () => {
    const until = Date.now() + 8000;
    const ready = () => typeof currentUser !== 'undefined' && currentUser && Array.isArray(librariesList) && librariesList.some(l => l.id);
    while (Date.now() < until && !ready()) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 400)); // preferences (pins, favorites) follow the libraries
    await loadRecentOpens();
    const s = hashToNav(location.hash);
    if (s) await navApply(s); else await setTab('files', 'home');
    return true;
  });
  await wait(ms);
  await page.eval(() => { const q = document.getElementById('file-quick-list'); if (q && /Loading/.test(q.textContent)) q.innerHTML = quickAccessHtml(); return true; });
};

// For chapter fixtures that want to build on this world.
exports.world = { NOW, MIN, HOUR, DAY, ago, ahead, U, wait, LIST_LATENCY, CONFIG, PEOPLE, ME, LIB, LIBRARIES, libOut, FILES, F, pub, TRASH, LINKS, FOLDER_LINKS, linkOut, folderLinkOut, GROUPS, LIB_SHARES, NOTIFS, CONNECTORS, fileDoor, libraryDoor, sharedWithMe, SITE };
