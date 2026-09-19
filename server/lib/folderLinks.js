// What a folder link may show and serve.
//
// Two kinds (migration 0015). A SNAPSHOT link -- anonymous, forwardable -- serves the files
// that were in the folder when it was made, wherever they are now. A LIVE link -- sent to
// one named person -- serves the folder as it is now. Both serve only what the link's MAKER
// can still publish, asked at the moment of use: a maker who has lost access takes the link
// down with them, and a file they lost drops out of it (lib/linkAccess).
//
// Everything a visitor can name -- a subfolder path, a file id -- is looked up INSIDE the
// set computed here. Nothing is ever fetched by a name or id the visitor supplied directly.
const db = require('./db');
const documentAccess = require('./documentAccess');
const linkAccess = require('./linkAccess');
const { tokenHash } = require('./shareLinks');
const { prefixRange } = require('./documents');

const COLUMNS = 'd.id, d.name, d.size, d.storage_path, d.mime_type, d.created_at';

// not_found | expired | { share }. A sign-in link does not exist for a public caller.
async function load(token, { allowSignin = false } = {}) {
  const share = await db.queryOne('SELECT * FROM folder_share_links WHERE token_hash = $1', [tokenHash(token)]);
  if (!share || share.revoked_at) return { error: 'not_found' };
  if (share.require_signin && !allowSignin) return { error: 'not_found' };
  if (share.expires_at && new Date(share.expires_at).getTime() < Date.now()) return { error: 'expired' };
  return { share };
}

// The files this link serves right now, each with `rel`: its path inside the shared folder.
async function docsFor(share) {
  let creator, docs;
  if (share.live && share.library_id) {
    creator = await linkAccess.linkCreator(share.created_by);
    docs = creator ? await db.query(
      `SELECT ${COLUMNS} FROM documents d
        WHERE d.library_id = $6 AND d.deleted_at IS NULL AND d.name NOT LIKE '%/.keep'
          AND ${prefixRange('d', '$7')} AND ${documentAccess.condition('d', 1)}
        ORDER BY d.name`,
      [...documentAccess.userParams(creator, 'write'), share.library_id, share.folder_path]) : [];
  } else {
    ({ creator, docs } = await linkAccess.servableDocs(share.created_by, share.document_ids, COLUMNS));
    docs = docs.filter(d => d.name !== '.keep' && !String(d.name).endsWith('/.keep'));
  }
  if (!creator) return { creator: null, docs: [] };
  const pre = share.folder_path + '/';
  return {
    creator,
    // A snapshot's file may have moved out from under the label since; it is still served,
    // at the top, under its own name (the link is meant to survive that).
    docs: docs.map(d => ({ ...d, rel: String(d.name).startsWith(pre) ? String(d.name).slice(pre.length) : String(d.name).split('/').pop() })),
  };
}

// A visitor's subfolder path, cleaned: segments only, no traversal, no empty parts.
function cleanSub(raw) {
  const parts = String(raw || '').replace(/\\/g, '/').split('/').map(s => s.trim()).filter(Boolean);
  if (parts.some(p => p === '.' || p === '..')) return null;
  return parts.join('/');
}

const under = (docs, sub) => (sub ? docs.filter(d => d.rel.startsWith(sub + '/')) : docs);

// One level of the folder: its subfolders (with what is in them) and its files.
function listing(docs, sub) {
  const inside = under(docs, sub);
  const cut = sub ? sub.length + 1 : 0;
  const folders = new Map(), files = [];
  for (const d of inside) {
    const rest = d.rel.slice(cut);
    const slash = rest.indexOf('/');
    if (slash < 0) { files.push({ id: d.id, name: rest, size: Number(d.size || 0), modified: d.created_at }); continue; }
    const name = rest.slice(0, slash);
    const f = folders.get(name) || { name, path: sub ? `${sub}/${name}` : name, files: 0, bytes: 0 };
    f.files++; f.bytes += Number(d.size || 0); folders.set(name, f);
  }
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  return { folders: [...folders.values()].sort(byName), files: files.sort(byName), bytes: inside.reduce((s, d) => s + Number(d.size || 0), 0), count: inside.length };
}

module.exports = { load, docsFor, cleanSub, under, listing, COLUMNS };
