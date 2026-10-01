// Fixture world "share-file-invited": the "Sharing a file" chapter AFTER the reader has
// clicked "Send invite to 2" for Marcus Chen and Dana Whitfield (shots/share-file.js,
// share-access). Used only by that one shot, so the earlier pictures in the chapter still
// show the file before the invite went out.
//
// Marcus has a Depot account, so the invite gives him the file directly (a file grant,
// Can view); Dana is outside Acme, so she gets a link of her own, which base.js already
// has (the active link to dana@northfield-clinic.example). QA: "Who has access" used to
// show only Dana's link, so Marcus seemed to have vanished after "Send invite to 2".
'use strict';
const chapter = require('./share-file');
const { world } = require('./base');
const { F, PEOPLE, ME, U, NOW, HOUR } = world;

const FILE = F['Northfield Clinic proposal'];
const GRANT = 'fg:' + U(702);
const at = new Date(NOW - 2 * HOUR).toISOString();

function withMarcus(out) {
  if (!out.people || !out.keys) return out;
  const m = PEOPLE.marcus;
  const reason = { key: GRANT, kind: 'file_grant', relation: 'at', level: 'read', permission: 'read', via_group: null, folder_path: null, granted_by: { email: ME.email, name: ME.name }, granted_at: at };
  out.people = [...out.people.filter((p) => p.user_id !== m.id), {
    ref: `u:${m.id}`, user_id: m.id, email: m.email, name: m.name, level: 'read', effective: 'read', view_only: false, is_owner: false,
    same_address_accounts: 1, partial: false, ways_in: 1, reasons: [reason],
  }];
  out.keys = [...out.keys, {
    ref: GRANT, kind: 'file_grant', id: U(702), folder_path: null, relation: 'at',
    subject: { type: 'user', email: m.email, name: m.name, account: 'ok' },
    permission: 'read', granted_by: { email: ME.email, name: ME.name }, granted_at: at, waiting: null, waiting_count: 0,
    change_here: true, can_remove: true, impact: { lose: [`u:${m.id}`], keep: [], unknown: [], admins_unaffected: 0 }, impact_if_read: null, files_impact: null,
    admits: [`u:${m.id}`], admits_admins: 0,
  }];
  return out;
}

exports.routes = {
  ...chapter.routes,
  'GET /api/access/files/:id': ({ params }) => {
    const f = world.FILES.find((x) => x.id === params.id);
    if (!f) return { __status: 404, body: { error: 'not found' } };
    const out = world.fileDoor(f);
    return f.id === FILE.id ? withMarcus(out) : out;
  },
};
