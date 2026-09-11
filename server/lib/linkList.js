'use strict';
// "My links" (piece 3): the public links someone made, or -- for an admin -- everyone's,
// each with the state its public route will actually give it. The state comes from
// lib/linkAccess, the same answer the public link routes use, so a list never says a
// link works when it doesn't (or the other way round).
const db = require('./db');
const documentAccess = require('./documentAccess');
const linkAccess = require('./linkAccess');
const { shareLinkClientShape, folderShareClientShape } = require('./shareLinks');

const LIMIT = 250;
const expired = (x) => !!x.expires_at && new Date(x.expires_at).getTime() < Date.now(); // as the public routes compare

// Why a link a creator made doesn't serve: they're gone, can only view, or lost edit.
async function pausedReason(createdBy) {
  const actor = createdBy ? await documentAccess.resolveActor(createdBy) : null;
  if (!actor) return 'creator_gone';
  if (actor.role !== 'admin' && actor.role !== 'contributor') return 'creator_view_only';
  return 'creator_cannot_edit';
}

// What each creator's links can still serve, once per creator: creator -> Set(doc id).
async function servingByCreator(pairs) {
  const byCreator = new Map();
  for (const [creator, ids] of pairs) {
    const k = String(creator || '');
    if (!byCreator.has(k)) byCreator.set(k, new Set());
    ids.forEach(i => byCreator.get(k).add(String(i)));
  }
  const out = new Map();
  for (const [creator, ids] of byCreator) {
    const { docs } = await linkAccess.servableDocs(creator || null, [...ids]);
    out.set(creator, { ids: new Set(docs.map(d => String(d.id))) });
  }
  return out;
}

// scope 'mine': links the caller made (whatever they can open now). 'all': every link
// (admins only -- the route checks). A file the caller can no longer open is named only
// as "a file you can no longer open".
async function listLinks(user, scope) {
  const mine = scope !== 'all';
  const p = documentAccess.userParams(user, 'read');
  const files = await db.query(
    `SELECT s.id, s.document_id, s.expires_at, s.revoked_at, s.created_at, s.created_by, s.created_by_email,
            s.recipient_email, s.allow_upload, s.last_accessed_at, s.access_count, s.password_hash,
            d.name AS document_name, d.deleted_at, d.library_id, l.name AS library_name,
            (${documentAccess.condition('d', 1)}) AS can_read
       FROM document_share_links s
       JOIN documents d ON d.id = s.document_id
       LEFT JOIN libraries l ON l.id = d.library_id
      WHERE ${mine ? 's.created_by = $6' : '$6::uuid IS NOT NULL'}
      ORDER BY (s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now())) DESC, s.created_at DESC, s.id
      LIMIT ${LIMIT}`,
    [...p, user.id]
  );
  const folders = await db.query(
    `SELECT f.id, f.folder_path, f.document_ids, f.expires_at, f.revoked_at, f.created_at, f.created_by, f.created_by_email,
            f.last_accessed_at, f.access_count, f.password_hash,
            (SELECT count(*)::int FROM documents d WHERE d.id = ANY(f.document_ids) AND d.deleted_at IS NULL) AS live,
            (SELECT l.name FROM documents d JOIN libraries l ON l.id = d.library_id
              WHERE d.id = ANY(f.document_ids) ORDER BY d.deleted_at NULLS FIRST, d.id LIMIT 1) AS library_name
       FROM folder_share_links f
      WHERE ${mine ? 'f.created_by = $1' : '$1::uuid IS NOT NULL'}
      ORDER BY (f.revoked_at IS NULL AND (f.expires_at IS NULL OR f.expires_at > now())) DESC, f.created_at DESC, f.id
      LIMIT ${LIMIT}`,
    [user.id]
  );
  const open = (x) => !x.revoked_at && !expired(x);
  const serving = await servingByCreator([
    ...files.filter(f => open(f) && !f.deleted_at).map(f => [f.created_by, [f.document_id]]),
    ...folders.filter(open).map(f => [f.created_by, f.document_ids || []]),
  ]);
  const reasons = new Map();
  const why = async (creator) => {
    const k = String(creator || '');
    if (!reasons.has(k)) reasons.set(k, await pausedReason(creator));
    return reasons.get(k);
  };
  const me = (x) => !!x.created_by && String(x.created_by) === String(user.id);

  const shares = [];
  for (const f of files) {
    const s = serving.get(String(f.created_by || ''));
    let state = 'active';
    if (f.revoked_at) state = 'revoked';
    else if (expired(f)) state = 'expired';
    else if (f.deleted_at) state = 'file_deleted';
    else if (!s || !s.ids.has(String(f.document_id))) state = 'paused';
    const hidden = !f.can_read;
    shares.push({
      ...shareLinkClientShape(f),
      document_name: hidden ? null : f.document_name,
      name_hidden: hidden,
      document_deleted: !!f.deleted_at,
      library_id: hidden ? null : f.library_id,
      library_name: hidden ? null : (f.library_name || null),
      created_by_me: me(f),
      state,
      paused_reason: state === 'paused' ? await why(f.created_by) : null,
    });
  }
  const folderLinks = [];
  for (const f of folders) {
    const s = serving.get(String(f.created_by || ''));
    const n = (f.document_ids || []).filter(i => s && s.ids.has(String(i))).length;
    let state = 'active';
    if (f.revoked_at) state = 'revoked';
    else if (expired(f)) state = 'expired';
    else if (!f.live) state = 'files_gone';
    else if (!n) state = 'paused';
    folderLinks.push({
      ...folderShareClientShape(f),
      library_name: f.library_name || null,
      created_by_me: me(f),
      state,
      serving: state === 'active' ? n : 0,
      paused_reason: state === 'paused' ? await why(f.created_by) : null,
    });
  }
  return { scope: mine ? 'mine' : 'all', shares, folder_links: folderLinks };
}

module.exports = { listLinks };
