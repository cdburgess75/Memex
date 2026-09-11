'use strict';
// Whether a public link may serve its files right now. One answer, shared by the public
// link routes and by every list that shows a link's state (who has access, my links),
// so what a list says a link does is what the link does.
//
// A link works only while its creator could still create it: an admin or contributor
// with edit rights on the file, checked live. Access can end in ways that touch
// nothing the link points at -- a share removed, a group left, a demotion to viewer --
// and a link must not outlive its creator's right to publish.
const db = require('./db');
const documentAccess = require('./documentAccess');

// The creator's live account, if it may publish links at all; null otherwise. `q` reads
// inside a caller's transaction (the key lists' snapshot); the public routes use the pool.
async function linkCreator(createdBy, q = db) {
  const creator = await documentAccess.resolveActor(createdBy, q);
  if (!creator || (creator.role !== 'admin' && creator.role !== 'contributor')) return null;
  return creator;
}

// A file link: the creator, while they can still publish this file (write, not in
// Trash); null otherwise.
async function creatorCanPublish(createdBy, documentId) {
  const creator = await linkCreator(createdBy);
  if (!creator) return null;
  const doc = await documentAccess.getAccessibleDocument({
    id: documentId, user: creator, required: 'write', columns: 'd.id', deleted: 'active',
  });
  return doc ? creator : null;
}

// A folder link's snapshot: the files it may still serve -- not in Trash, and the
// creator can still publish each one -- with the columns asked for, by name. The
// creator is null when they can't publish links at all (then nothing is served).
async function servableDocs(createdBy, ids, columns = 'd.id', q = db) {
  const creator = await linkCreator(createdBy, q);
  const list = Array.isArray(ids) ? ids : [];
  if (!creator || !list.length) return { creator, docs: [] };
  const docs = await q.query(
    `SELECT ${columns} FROM documents d
       WHERE d.id = ANY($1::uuid[]) AND d.deleted_at IS NULL AND ${documentAccess.condition('d', 2)}
       ORDER BY d.name`,
    [list, ...documentAccess.userParams(creator, 'write')]
  );
  return { creator, docs };
}

module.exports = { linkCreator, creatorCanPublish, servableDocs };
