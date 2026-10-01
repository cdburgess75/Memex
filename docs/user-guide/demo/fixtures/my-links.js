// Fixture overrides for "Keeping track of what you've shared" (id my-links).
//
// base.js's My links story already has one Active link with a recipient and "can send
// files back" (Northfield Clinic proposal), one with a password (Harbor Point Dental
// proposal), one that never expires (Brand guidelines), one Expired and one Revoked.
// It has no Paused or Deleted example, so the My links page cannot show all five status
// chips. This file re-answers GET /api/files/shares with the same five links reordered
// (Northfield and Harbor Point first, so they land side by side as the first two cards
// under the default Active+Paused view) plus one Paused and one Deleted link.
//
// Both synthetic links are picked to match the real server logic in lib/linkList.js
// (a link pauses when its creator currently cannot edit the document; document_deleted
// is just !!file.deleted_at), so they do not contradict what the rest of the demo world
// says about Jordan's access or about which files still exist:
//   - Paused uses a Finance file. Jordan has read-only access to the whole Finance
//     library, so he genuinely cannot edit it right now (unlike, say, a Marketing file,
//     where he has Read-Write and a "can no longer edit" message would be false).
//   - Deleted uses the actual Trash item "Northfield Clinic proposal v1.docx" (an older
//     draft, superseded and deleted) instead of a live file, so no other picture or
//     chapter shows this exact document as still existing.
'use strict';
const { world } = require('./base');
const { F, TRASH, U, ago, ahead, DAY, LINKS, FOLDER_LINKS, linkOut, folderLinkOut, ME } = world;

const byId = (id) => LINKS.find((l) => l.id === id);
const NORTHFIELD = byId(U(301));   // active, sent to Dana, can send files back
const HARBOR = byId(U(303));       // active, password
const BRAND = byId(U(302));        // active, never expires
const OFFSITE = byId(U(304));      // expired
const MAPLE = byId(U(305));        // revoked

// Paused: the link still looks fine, but Jordan can no longer edit the file behind it
// (the app pauses a link automatically when its creator loses edit rights), so it will
// not open until it is revoked or the rights come back. Expense policy.pdf is in
// Finance, where Jordan's access is read-only, so this is true right now.
const PAUSED = {
  id: U(306), document_id: F['Expense policy'].id, expires_at: null, revoked_at: null,
  created_at: ago(6 * DAY), created_by_email: ME.email, recipient_email: null, require_signin: false,
  opened_at: ago(5 * DAY), allow_upload: false, last_accessed_at: ago(5 * DAY), access_count: 2,
  has_password: false, url: null,
  document_name: F['Expense policy'].name, name_hidden: false, document_deleted: false,
  library_id: F['Expense policy'].library_id, library_name: 'Finance',
  created_by_me: true, state: 'paused', paused_reason: null,
};
// Deleted: the file the link pointed to was removed, so My links files it under Deleted.
// This is the draft Jordan actually deleted from Trash 1 day ago (see world-notes), not a
// file that still appears elsewhere in the demo as live.
const OLD_DRAFT = TRASH.find((f) => f.name === 'Proposals/2026/Northfield Clinic proposal v1.docx');
const DELETED = {
  id: U(307), document_id: OLD_DRAFT.id, expires_at: ahead(10 * DAY), revoked_at: null,
  created_at: ago(15 * DAY), created_by_email: ME.email, recipient_email: null, require_signin: false,
  opened_at: ago(5 * DAY), allow_upload: false, last_accessed_at: ago(5 * DAY), access_count: 4,
  has_password: false, url: null,
  document_name: OLD_DRAFT.name, name_hidden: false, document_deleted: true,
  library_id: OLD_DRAFT.library_id, library_name: 'Jordan Lee',
  created_by_me: true, state: 'file_deleted', paused_reason: null,
};

exports.routes = {
  'GET /api/files/shares': ({ query }) => ({
    scope: query.scope === 'all' ? 'all' : 'mine',
    shares: [NORTHFIELD, HARBOR, BRAND].map(linkOut).concat([PAUSED]).concat([OFFSITE, MAPLE].map(linkOut)).concat([DELETED]),
    folder_links: FOLDER_LINKS.map(folderLinkOut),
  }),
};
